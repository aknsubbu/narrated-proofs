"""Say exactly what is wrong when a scene's TeX does not compile, in lines the lesson writer can act on.

A LaTeX failure used to reach the writer as the last 45 lines of manim's traceback. That names
the TeX error but not the string it was in (manim prints it clipped to 70 characters), and for a
helper such as `def T(s): return Tex(s)` it points at the helper, not at the line that passed
the bad string. Two things here fix that, and check.py calls both:

    check_literals   before any scene runs: find every `Tex("...")` / `TexText("...")` whose text is
                     written out in scenes.py, compile each, and report every one that fails at
                     once. A bad formula is otherwise found one scene, one fix round, at a time.
    explain_failure  after a scene fails on TeX: read the compile manim left in build/latex_cache
                     and say the line, the string and TeX's own error. This also catches what the
                     first cannot see: strings built with f-strings or variables, and colour
                     markup manim wraps around parts of a string (t2c) that makes it fail.

Nothing the scene wrote is run here. The first only reads string constants out of the file with
`ast`; the compile is done by manim's own Tex class (so by its template, its preamble and its
flags) in texprobe.py, under the sandbox a scene is checked in. A string is only ever given to
TeX, as it is when the scene renders.
"""
import ast
import collections
import json
import re
import subprocess
import sys
from pathlib import Path

import build
import sandbox
import texprobe
from texprobe import tex_error  # noqa: F401  (the log reading is shared with the probe)

PROBE_TIMEOUT = 300  # seconds; an uncached string takes about a third of a second, so this is hundreds of them
MAX_STRINGS = 500
SHOWN = 400  # characters of a TeX string to show

TEX_CLASSES = {"Tex", "TexText", "MTex"}
# Settings that change what is compiled. A string given one of these cannot be tried on its own.
OWN_TEMPLATE = {"template", "additional_preamble", "alignment", "tex_environment"}

_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_FRAME = re.compile(r'^\s*File "([^"]+)", line (\d+), in (.+)$')
_COLOUR = re.compile(r"\{\{\\color\[RGB\]\{\d+, \d+, \d+\}")  # what manim puts round a part of a string it colours

# Errors TeX words so that the cause is hard to see. What to write instead is the useful part.
HINTS = (
    (r"\\T3\\\|", r"`\|` cannot be used here: manim's TeX template loads the tipa package, which redefines it. "
                  r"Write \Vert for a norm or a double bar (or \parallel), and \mid or | for a divider."),
    (r"Undefined control sequence", r"That command is not defined by the packages manim loads (amsmath, amssymb, physics, mathrsfs, dsfont, ...). "
                                     r"Check its spelling, or build the symbol from ones that exist."),
    (r"Missing \$ inserted", r"TeX met maths-only syntax (^, _ or a symbol such as \alpha) outside maths. Tex() is already in maths mode, so look for "
                             r"a stray $ or an unclosed \text{; TexText() is text mode, so put its maths inside $...$."),
    (r"Misplaced alignment tab character &", r"To print an ampersand write \&. A bare & is a column separator and only works at the top level of Tex()."),
    (r"Unicode character|inputenc Error", r"Replace the unicode character with its LaTeX command (\alpha, \cdot, \le, ...), or Text() if it is prose."),
    (r"Missing \} inserted|Extra \}|Too many \}'s|Missing \{ inserted", r"The braces do not balance: count the { and } in the string."),
)


# ---------- finding the strings in scenes.py ----------

def _fold(node):
    """The text of a string written out in the source, or None: a quoted string, or quoted strings added together."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _fold(node.left), _fold(node.right)
        return left + right if left is not None and right is not None else None
    return None


def _tex_class(node):
    if not isinstance(node, ast.Call):
        return None
    name = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", None)
    return name if name in TEX_CLASSES else None


def _plain(call):
    """True when the call has nothing in it that changes what gets compiled, or hides the arguments."""
    if any(isinstance(a, ast.Starred) for a in call.args):
        return False
    return not any(k.arg is None or k.arg in OWN_TEMPLATE for k in call.keywords)


def _forwarders(tree):
    """{function name: (position, keyword, class)} for functions that pass one of their own arguments
    straight to Tex, as in `def T(s, size=44): return Tex(s, font_size=size)`. The strings written out
    where such a function is called are TeX too. Only a name defined once, and an argument that is
    passed on untouched, count: anything cleverer is left for the scene's own run to report."""
    defined = collections.Counter(n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef))
    out = {}
    for fn in ast.walk(tree):
        if not isinstance(fn, ast.FunctionDef) or defined[fn.name] != 1:
            continue
        params = [a.arg for a in fn.args.args]
        rebound = {n.id for n in ast.walk(fn) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
        for call in ast.walk(fn):
            cls = _tex_class(call)
            if not (cls and _plain(call) and len(call.args) == 1 and isinstance(call.args[0], ast.Name)):
                continue
            arg = call.args[0].id
            if arg in params and arg not in rebound:
                skip = 1 if params[0] in ("self", "cls") else 0  # a method's caller does not pass self
                if params.index(arg) >= skip:
                    out[fn.name] = (params.index(arg) - skip, arg, cls)
                break
    return out


def tex_strings(tree):
    """[{"line", "cls", "strings", "via"}] for each Tex written with its text spelled out, in file order.
    `via` names the helper function the string was passed to, or is None for a direct Tex(...)."""
    found = []
    forwarders = _forwarders(tree)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        cls = _tex_class(node)
        if cls and _plain(node) and node.args:
            texts = [_fold(a) for a in node.args]
            if all(t is not None for t in texts):
                found.append({"line": node.lineno, "cls": cls, "strings": texts, "via": None})
            continue
        name = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", None)
        if name in forwarders and not any(isinstance(a, ast.Starred) for a in node.args):
            position, keyword, cls = forwarders[name]
            arg = node.args[position] if len(node.args) > position else next((k.value for k in node.keywords if k.arg == keyword), None)
            text = _fold(arg) if arg is not None else None
            if text is not None:
                found.append({"line": node.lineno, "cls": cls, "strings": [text], "via": name})
    return sorted(found, key=lambda f: f["line"])


# ---------- compiling them ----------

def _shorten(text, limit=SHOWN):
    text = " ".join(text.split()) if "\n" in text else text
    return text if len(text) <= limit else text[:limit] + " ..."


def hint(error):
    """What to do about a TeX error, when it is one that is easy to misread; else ""."""
    for pattern, advice in HINTS:
        if re.search(pattern, error):
            if pattern.startswith("Undefined"):  # TeX shows the command it did not know at the end of a context line
                shown = (re.search(r"(\\[A-Za-z]+)\s*$", x) for x in error.split("\n")[1:])
                command = next((m.group(1) for m in shown if m and m.group(1) != "\\par"), None)
                if command:
                    return f"{command} is not a command here. " + advice
            return advice
    return ""


def describe(tex, error_lines, tex_error_text=""):
    """The part of a message that is the same wherever the string came from."""
    shown = "\n".join(f"    {x}" for x in error_lines[:6]) or f"    {tex_error_text}"
    out = f"TeX string:\n    {_shorten(tex)}\nTeX error:\n{shown}"
    advice = hint("\n".join([*error_lines, tex_error_text]))
    return out + (f"\nHint: {advice}" if advice else "")


def probe(root, items):
    """manim's own answer for each of `items` ({"cls", "strings"}): None where it compiles, else
    {"error", "tex"}. The list itself is None if the probe could not be run at all, in which case
    the scenes' own runs still find the problem, just one at a time."""
    if not items or not Path(build.MANIMGL).exists():
        return None
    out = Path(root) / "build" / "check" / "tex.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.unlink(missing_ok=True)
    env, manim_args, limits = sandbox.prepare(root)
    # The runtime folder goes with the job so the probe compiles with the same TeX repairs a scene gets (texfix.py).
    job = json.dumps({"config": manim_args[1], "out": str(out), "items": items, "runtime": str(sandbox.RUNTIME)})
    # `-I` so that nothing in the project folder can stand in for a module the probe imports. The
    # probe goes in as text because the sandbox lets a run read its project, not this folder.
    cmd = [str(sandbox.interpreter(build.MANIMGL)), "-I", "-c", Path(texprobe.__file__).read_text(encoding="utf-8")]
    print(f"$ compiling the {len(items)} TeX strings written out in the scenes", file=sys.stderr, flush=True)
    try:
        done = subprocess.run(
            sandbox.wrap(cmd, root), cwd=root, env=env, input=job, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, timeout=PROBE_TIMEOUT, preexec_fn=limits,
        )
        results = json.loads(out.read_text(encoding="utf-8"))["results"]
    except (subprocess.TimeoutExpired, OSError, ValueError, KeyError) as e:
        print(f"texcheck: could not try the TeX strings ({type(e).__name__}); the scenes will say as they run", file=sys.stderr)
        return None
    return results if len(results) == len(items) else (print(f"texcheck: the probe failed: {done.stdout[-300:]}", file=sys.stderr) or None)


def check_literals(root, config, report):
    """Report every Tex string written out in scenes.py that does not compile, each with its line.
    Does nothing if the file cannot be read; check_static has already said so."""
    name = config.get("scenes_file", "scenes.py")
    try:
        tree = ast.parse((Path(root) / name).read_text(encoding="utf-8"), filename=name)
    except (OSError, SyntaxError):
        return
    groups = {}  # (class, strings) -> where it is written
    for found in tex_strings(tree):
        groups.setdefault((found["cls"], tuple(found["strings"])), []).append(found)
    keys = list(groups)[:MAX_STRINGS]
    results = probe(root, [{"cls": cls, "strings": list(strings)} for cls, strings in keys])
    if not results:
        return
    seen = report.tex_reported = getattr(report, "tex_reported", {})  # string -> line, so the scene run does not say it again
    for key, result in zip(keys, results):
        if not result:
            continue
        places = groups[key]
        first = places[0]
        tex = " ".join(key[1]).strip()  # as manim joins and trims them
        seen[tex] = first["line"]
        via = f" (passed to {first['via']}(), which builds the Tex)" if first["via"] else ""
        more = f"; also at line(s) {', '.join(str(p['line']) for p in places[1:])}" if len(places) > 1 else ""
        report.error(name, f"line {first['line']}: this {first['cls']} string does not compile{via}{more}\n" + describe(tex, result["tex"], result["error"]),
                     file=name, line=first["line"])


# ---------- a scene that failed on TeX ----------

def plain_tex(body):
    """`body` as written, without the `{{\\color[RGB]{r, g, b} ... }}` manim wraps round parts it colours."""
    out, depth, targets, i = [], 0, [], 0
    while i < len(body):
        mark = _COLOUR.match(body, i)
        if mark:
            targets.append(depth)
            depth += 2
            i = mark.end()
        elif targets and depth == targets[-1] + 2 and body.startswith("}}", i):
            depth = targets.pop()
            i += 2
        else:
            ch = body[i]
            step = 2 if ch == "\\" else 1  # \{ and \} are not braces
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
            out.append(body[i:i + step])
            i += step
    return "".join(out)


def compiled_tex(root, printed):
    """The string manim last tried to compile, whole, from the file it leaves in build/latex_cache; None
    if that file is not from this failure. `printed` is manim's `Writing ...` line, whose start must match."""
    try:
        full = (Path(root) / "build" / "latex_cache" / "working.tex").read_text(encoding="utf-8")
    except OSError:
        return None
    body = full.partition("\\begin{document}")[2].rpartition("\\end{document}")[0].partition("\\centering\n")[2]
    if body.startswith("\\begin{align*}\n"):  # Tex puts its string in align*; TexText only centres it
        body = body[len("\\begin{align*}\n"):].rpartition("\n\\end{align*}")[0]
    plain = plain_tex(body.strip())
    return plain if plain and plain.startswith(printed[:60]) else None


def explain_failure(root, scenes_file, output, scene, report=None):
    """(message, extra for Report.error) for a scene that failed because TeX did not compile, else None.

    The line is the outermost one in scenes.py (the one in the scene's own code), which for a
    helper is the line that passed the string, not the line inside the helper."""
    text = _ANSI.sub("", output).replace("\r", "\n")
    lines = text.split("\n")
    errors = [i for i, x in enumerate(lines) if "LatexError:" in x]
    if not errors:
        return None
    mine = Path(scenes_file).name
    frames = []
    for i, x in enumerate(lines):
        m = _FRAME.match(x)
        if m and Path(m.group(1)).name == mine:
            source = lines[i + 1].strip() if i + 1 < len(lines) and not lines[i + 1].lstrip().startswith("File ") else ""
            frames.append((int(m.group(2)), m.group(3), "" if set(source) <= set("^~ ") else source))
    error = lines[errors[-1]].partition("LatexError:")[2].strip()
    writing = next((x[len("Writing "):] for x in reversed(lines[:errors[-1]]) if x.startswith("Writing ")), "")
    printed = writing[:-3] if writing.endswith("...") else writing  # manim clips what it prints to 70 characters
    tex = compiled_tex(root, printed)
    clipped = ""
    if tex is None:
        tex, clipped = printed, " ... (manim printed only the start)" if len(printed) >= 70 else ""
    log = tex_error(Path(root) / "build" / "latex_cache" / "working.log")
    extra = {"file": scenes_file, "line": frames[0][0], "scene": scene} if frames else {}
    where = f"{scenes_file} line {frames[0][0]}" if frames else scenes_file
    head = f"{where}: TeX does not compile in scene {scene}"
    if len(frames) > 1 and frames[-1][0] != frames[0][0]:
        head += f" (the Tex is built in {frames[-1][1]}() at line {frames[-1][0]}, from the call at line {frames[0][0]})"
    if report is not None and tex and getattr(report, "tex_reported", {}).get(tex):
        return f"{head}, on the string already reported at {scenes_file} line {report.tex_reported[tex]}. Fix that one.", extra
    call = f"\nThe call: {frames[0][2]}" if frames and frames[0][2] else ""
    return f"{head}.{call}\n" + describe(tex + clipped, log, error), extra
