#!/usr/bin/env python3
"""Fix the mistakes a model makes most often in scenes.py, without asking a model.

    python3 autofix.py <project> --report check.json    # prints {"changed": true, "fixes": [...]}

Three kinds of fix, all safe to apply blindly:

  names that never exist in ManimGL, from the other Manim or from habit:
      MathTex -> Tex, Create -> ShowCreation, axes.plot -> axes.get_graph,
      self.camera.frame -> self.frame, GRAY -> GREY, LIGHT_GREY -> GREY_B,
      PINK_B -> PINK (PINK and ORANGE have no shades), ...
  calls written the other Manim's way:
      FadeOut(*things) -> FadeOut(Group(*things)), NumberLine(length=9) -> width=9
  a shade the report's NameError says a colour lacks, and a mark or block name one typo
  away from a real one, when check.py's report names the line and lists the real ones and
  exactly one of them is close.

The lesson writer runs this before asking Claude to fix a failing check, and asks only
about what is left. Standard library only.
"""
import argparse
import difflib
import json
import re
import sys
from pathlib import Path

# (name, pattern, replacement, what to say). Each pattern only matches names ManimGL does not
# have; `name` is skipped when the file defines it itself, as a class, function or variable.
RENAMES = [
    ("MathTex", r"\bMathTex\(", "Tex(", "MathTex is Tex in ManimGL"),
    ("Create", r"(?<![\w.])Create\(", "ShowCreation(", "Create is ShowCreation in ManimGL"),
    (None, r"\.plot\(", ".get_graph(", "axes.plot is axes.get_graph in ManimGL"),
    (None, r"\bself\.camera\.frame\b", "self.frame", "the camera frame is self.frame in ManimGL"),
    (None, r"^from manim import \*", "from manimlib import *", "the module is manimlib"),
    ("LIGHT_GREY", r"\bLIGHT_GR[EA]Y\b", "GREY_B", "ManimGL has no LIGHT_GREY; GREY_B is the light grey"),
    ("DARK_GREY", r"\bDARK_GR[EA]Y\b", "GREY_D", "ManimGL has no DARK_GREY; GREY_D is the dark grey"),
    # Not everything on screen is a VMobject, and VGroup refuses the rest; Group takes anything and fades the same.
    (None, r"\bVGroup\(\*self\.mobjects\)", "Group(*self.mobjects)", "VGroup(*self.mobjects) fails on a mobject that is not a VMobject; Group takes any"),
    ("GRAY", r"\bGRAY(_[A-E])?\b", r"GREY\1", "ManimGL spells it GREY"),
    # Only these two colours have no shades (checked against manimlib/constants.py). The
    # NameError rule below catches the same slip for any other colour.
    *[
        (f"{colour}_{shade}", rf"\b{colour}_{shade}\b", colour, f"ManimGL has no {colour}_{shade}; {colour} has no shades")
        for colour in ("PINK", "ORANGE")
        for shade in "ABCDE"
    ],
]

_UNKNOWN_MARK = re.compile(r'^line (\d+): block "([^"]+)" has no mark "([^"]+)"\. Its marks: (.*)$')
# Python's own suggestion for a misspelt name: "name 'PINK_B' is not defined. Did you mean: 'PINK'?"
_NAME_ERROR = re.compile(r"NameError: name '(\w+)' is not defined\. Did you mean: '(\w+)'\?")
_UNKNOWN_BLOCK = re.compile(r'^line (\d+): self\.voiceover\("([^"]+)"\) names a block that is not in the script\. Blocks: (.*)$')


def closest(wrong, known):
    """The one known name close to `wrong`, or None when there is none or more than one."""
    if not known:
        return None
    same_case = [k for k in known if k.lower() == wrong.lower()]
    if len(same_case) == 1:
        return same_case[0]
    close = difflib.get_close_matches(wrong, known, n=2, cutoff=0.75)
    return close[0] if len(close) == 1 else None


def rename_on_line(lines, number, wrong, right):
    """Swap the string literal "wrong" for "right" on one line. True if it was there."""
    i = number - 1
    if not 0 <= i < len(lines):
        return False
    new = re.sub(rf'(["\']){re.escape(wrong)}\1', lambda m: f"{m.group(1)}{right}{m.group(1)}", lines[i])
    if new == lines[i]:
        return False
    lines[i] = new
    return True


def _walk(source, start):
    """(index, char, depth) from `start`, leaving out string literals and comments.
    A bracket has the depth outside it, so a call's own parentheses are depth 0 and its arguments 1."""
    depth, quote, i = 0, None, start
    while i < len(source):
        c = source[i]
        if quote:
            if c == "\\":
                i += 1
            elif source.startswith(quote, i):
                i += len(quote) - 1
                quote = None
        elif c == "#":
            i = source.find("\n", i)
            if i < 0:
                return
        elif c in "\"'":
            quote = c * 3 if source.startswith(c * 3, i) else c
            i += len(quote) - 1
        elif c in "([{":
            yield i, c, depth
            depth += 1
        elif c in ")]}":
            depth -= 1
            yield i, c, depth
        else:
            yield i, c, depth
        i += 1


def _call_end(source, open_at):
    """Index of the ")" that closes the "(" at `open_at`, or -1."""
    return next((i for i, c, d in _walk(source, open_at) if c in ")]}" and d == 0), -1)


def fix_calls(source, defined=()):
    """Mistakes in how a Manim Community call is written, not in a name it has: (new source, [fixes])."""
    fixes = []
    # FadeOut(*things) is Manim Community's. ManimGL's FadeOut and FadeIn take one mobject, so many go in a Group.
    done, pos = 0, 0
    if not {"FadeOut", "FadeIn", "Group"} & set(defined):
        while m := re.compile(r"(?<![\w.])(FadeOut|FadeIn)\(\s*\*").search(source, pos):
            open_at = m.start() + len(m.group(1))
            close = _call_end(source, open_at)
            pos = m.end()
            if open_at not in {i for i, _, _ in _walk(source, 0)}:
                continue  # in a string or a comment
            # With other arguments after it (run_time=...) the starred part cannot simply be wrapped.
            if close < 0 or any(c == "," and d == 1 for _, c, d in _walk(source[open_at:close + 1], 0)):
                continue
            source = f"{source[:open_at + 1]}Group({source[open_at + 1:close].strip()}){source[close:]}"
            done += 1
    if done:
        fixes.append(f"FadeOut and FadeIn take one mobject in ManimGL; many go in a Group ({done}x)")
    # NumberLine(..., length=9) is Manim Community's; the same thing is width= in ManimGL.
    done, pos = 0, 0
    while "NumberLine" not in defined and (m := re.compile(r"(?<![\w.])NumberLine\(").search(source, pos)):
        open_at, pos = m.end() - 1, m.end()
        if open_at not in {i for i, _, _ in _walk(source, 0)}:
            continue  # in a string or a comment
        close = _call_end(source, open_at)
        call = source[open_at:close + 1] if close > 0 else ""
        # Only the call's own keyword, never one inside it such as tip_config=dict(length=0.2).
        hit = next((i for i, c, d in _walk(call, 0) if d == 1 and re.match(r"length\s*=(?!=)", call[i:]) and call[:i].rstrip()[-1:] in "(,"), None)
        if hit is not None:
            source = f"{source[:open_at + hit]}width{source[open_at + hit + len('length'):]}"
            done += 1
    if done:
        fixes.append(f"NumberLine takes width=, not length=, in ManimGL ({done}x)")
    return source, fixes


def fix_source(source, errors=()):
    """Return (new source, [what was fixed])."""
    fixes = []
    defined = set(re.findall(r"^\s*(?:class|def)\s+(\w+)|^(\w+)\s*=", source, re.M))
    defined = {a or b for a, b in defined}
    for name, pattern, replacement, why in RENAMES:
        if name and name in defined:
            continue
        new, n = re.subn(pattern, replacement, source, flags=re.M)
        if n:
            source = new
            fixes.append(f"{why} ({n}x)")
    source, more = fix_calls(source, defined)
    fixes += more
    lines = source.split("\n")
    for e in errors:
        if e.get("where", "").endswith("script.txt"):
            continue
        message = e.get("message", "")
        m = _NAME_ERROR.search(message)
        if m:
            # Only the one slip that is certain: a shade (_A to _E) put on a colour that has none,
            # where Python's suggestion is that colour itself. Other misspellings are left to the writer.
            wrong, right = m.group(1), m.group(2)
            if wrong in defined or not re.fullmatch(rf"{re.escape(right)}_[A-E]", wrong) or not right.isupper():
                continue
            text, n = re.subn(rf"\b{wrong}\b", right, "\n".join(lines))
            if n:
                lines = text.split("\n")
                fixes.append(f"{right} has no shades, so {wrong} is {right} ({n}x)")
            continue
        m = _UNKNOWN_MARK.match(message)
        if m:
            number, block, wrong, known = int(m.group(1)), m.group(2), m.group(3), m.group(4)
            right = closest(wrong, [k.strip() for k in known.split(",") if k.strip() and k.strip() != "none"])
            if right and rename_on_line(lines, number, wrong, right):
                fixes.append(f'line {number}: mark "{wrong}" in block "{block}" is "{right}"')
            continue
        m = _UNKNOWN_BLOCK.match(message)
        if m:
            number, wrong, known = int(m.group(1)), m.group(2), m.group(3)
            right = closest(wrong, [k.strip() for k in known.split(",") if k.strip()])
            if right and rename_on_line(lines, number, wrong, right):
                fixes.append(f'line {number}: block "{wrong}" is "{right}"')
    return "\n".join(lines), fixes


def autofix(root, errors=()):
    path = Path(root) / "scenes.py"
    config = Path(root) / "project.json"
    if config.is_file():
        path = Path(root) / json.loads(config.read_text(encoding="utf-8")).get("scenes_file", "scenes.py")
    source = path.read_text(encoding="utf-8")
    new, fixes = fix_source(source, errors)
    if new != source:
        path.write_text(new, encoding="utf-8")
    return {"changed": new != source, "fixes": fixes}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Fix common mistakes in a project's scenes.py.")
    ap.add_argument("project", help="path to a project folder")
    ap.add_argument("--report", help="check.py's JSON report, for fixes that need its errors")
    args = ap.parse_args(argv)
    errors = json.loads(Path(args.report).read_text(encoding="utf-8")).get("errors", []) if args.report else []
    print(json.dumps(autofix(Path(args.project), errors)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
