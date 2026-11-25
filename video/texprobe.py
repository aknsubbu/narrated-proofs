"""Compile TeX strings the way manim would, and write down which ones fail. Not run directly.

texcheck.py starts this under the Python that runs manimgl, inside the same sandbox a scene is
checked in, by handing its source to `python -c`; that is how it can be read there, since the
sandbox lets a run read its project and runtime/ but not this folder. It must not import
anything from video/ for the same reason.

stdin is JSON, {"config": "<manim-config.json>", "out": "<result file>", "items": [{"cls": "Tex", "strings": ["x^2"]}]}.
Nothing in it is run: `cls` picks one of the two classes named below and the strings are
only handed to TeX, which is exactly what rendering a scene does with them. The answer is
written to "out" (manim prints progress on stdout, which would get in the way) as
{"results": [null | {"error": "...", "tex": ["! ...", "l.3 ..."]}]}, one per item: null for a string that compiles.
"""
import json
import os
import re
import sys

CLASSES = ("Tex", "TexText", "MTex")  # the only names a string may be given to; MTex only where this manim has it


def tex_error(log_path):
    """The first error TeX logged, with the line it stopped at: ["! Undefined control sequence.", "l.3 \\hatt"]."""
    try:
        with open(log_path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return []
    start = re.search(r"^! .*$", text, re.M)
    if not start:
        return []
    out = []
    lines = text[start.start():].split("\n")
    for i, line in enumerate(lines[:12]):
        if re.match(r"Type  H <return>|See the LaTeX manual|\s*\.\.\.\s*$", line):  # TeX's help text, not news
            continue
        if re.match(r"l\.\d+ ", line):  # TeX shows the line it stopped on, then what is left of it
            # Stopped on the line manim closes its wrapper with: the error is above, in the string, and this says nothing.
            if not re.match(r"l\.\d+ \\end\{align\*\}", line):
                out.append(line.rstrip())
                if i + 1 < len(lines) and lines[i + 1].strip():
                    out.append(lines[i + 1].strip())
            break
        out.append(line.rstrip())
    return [x for x in out if x.strip()]


def main():
    job = json.load(sys.stdin)
    sys.argv = ["manimgl", "--config_file", job["config"]]  # manim reads its settings from the command line at import
    import manimlib
    from manimlib.config import manim_config

    # A scene's formulas compile with texfix's repairs (`\|`, `\;` and friends put back to their maths
    # meanings), so the probe must too, or it would refuse strings the scene draws correctly. `-I` keeps
    # the project folder off the path; the runtime folder is ours, and the sandbox lets a run read it.
    if job.get("runtime"):
        sys.path.insert(0, job["runtime"])
        import texfix

        texfix.install()

    work = manim_config.directories.latex_cache
    log_path = f"{work}/working.log"
    results = []
    for item in job["items"]:
        # manim takes a leftover working.dvi from the string before as proof that this one compiled, so a
        # failing string after a good one would pass and be drawn as the other string. Start each clean.
        for ext in (".dvi", ".xdv", ".log", ".tex", ".aux"):
            try:
                os.unlink(f"{work}/working{ext}")
            except OSError:
                pass
        cls = getattr(manimlib, item["cls"], None) if item["cls"] in CLASSES else None
        if cls is None:
            results.append(None)  # a name this manim does not have: the scene itself will say so
            continue
        try:
            cls(*item["strings"])
            results.append(None)
        except Exception as e:  # LatexError, or the ValueError manim raises for unbalanced braces
            results.append({"error": str(e).strip(), "tex": tex_error(log_path) if "latex" in type(e).__name__.lower() else []})
    with open(job["out"], "w", encoding="utf-8") as f:
        json.dump({"results": results}, f)


if __name__ == "__main__":
    main()
