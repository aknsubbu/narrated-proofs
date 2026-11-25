"""Two repairs to how ManimGL compiles LaTeX, installed by voiceover.py and kit.py when a scene starts.

1. The default template loads `tipa`, which turns `\\|`, `\\;`, `\\:` and `\\!` into text accents
   even inside maths. So `\\|x\\|` stops LaTeX with "Argument of \\T3\\| has an extra }", a `\\;\\;`
   does the same, and a lone `\\;` quietly swallows the next character. These are everyday
   spellings (norms, spacing), so they are put back to their maths meanings in the preamble.

2. When LaTeX fails, manimlib only raises if no `working.dvi` is left over from an earlier
   formula (tex_file_writing.py, `returncode != 0 and not dvi_path.exists()`). One is always left
   after the first formula in a project, so a broken formula silently gets the previous
   formula's picture, and that wrong picture is cached on disk under the broken formula's key.
   With `t2c` the picture's part labels no longer fit the new string and building the Tex ends in
   `IndexError: list index out of range` in StringMobject. The leftover is removed before each
   compile, so a LaTeX error is raised as the LatexError it is.

Both patch functions of manimlib.utils.tex_file_writing, which Tex, TexText and MTex all go
through, so every way a scene can build a formula is covered and nothing has to reach into the
scene's namespace. The fixed preamble also changes every compile's cache key, so entries cached
from the old behaviour (some are wrong pictures, see 2) are never used again.

install() only touches manimlib once it is imported; with a stand-in manimlib (the unit tests)
or none, it does nothing.
"""
import sys
from pathlib import Path

# Put back, after tipa, what `\|` (a delimiter, as `\Vert`), `\;`, `\:` and `\!` mean in maths.
# Their text meanings are tipa's phonetic accents, which a lesson never uses.
PREAMBLE_FIX = r"""
\makeatletter
\DeclareRobustCommand{\;}{\relax\ifmmode\mskip\thickmuskip\else\kern.2777em\fi}
\DeclareRobustCommand{\:}{\relax\ifmmode\mskip\medmuskip\else\kern.2222em\fi}
\DeclareRobustCommand{\!}{\relax\ifmmode\mskip-\thinmuskip\else\kern-.1667em\fi}
\let\|\Vert
\makeatother
"""

_installed = False


def install():
    """Patch manimlib's LaTeX compile once. True when it is (now) patched."""
    global _installed
    if _installed:
        return True
    if "manimlib" not in sys.modules:
        return False  # not in manimgl; a later call, once manimlib is loaded, patches it
    try:
        from manimlib.config import manim_config
        from manimlib.utils import tex_file_writing as tfw
        original_full_tex, original_to_svg = tfw.get_full_tex, tfw.full_tex_to_svg
    except Exception:  # a stand-in manimlib, or a version without these functions
        return False

    def get_full_tex(content, preamble=""):
        return original_full_tex(content, "\n".join([preamble, PREAMBLE_FIX]))

    def full_tex_to_svg(full_tex, compiler="latex", message=""):
        folder = manim_config.directories.latex_cache
        for leftover in ("working.dvi", "working.xdv"):
            try:
                (Path(folder) / leftover).unlink()
            except OSError:  # none left, or not ours to remove: manimlib then behaves as before
                pass
        return original_to_svg(full_tex, compiler, message)

    tfw.get_full_tex = get_full_tex
    tfw.full_tex_to_svg = full_tex_to_svg
    _installed = True
    return True
