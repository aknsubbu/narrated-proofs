"""texfix.py: formulas the default ManimGL template broke now build, and real LaTeX errors still raise.

The real-toolchain tests run a small script in a child process (manimlib reads sys.argv and the
working folder when it is imported) with its own manim cache and LaTeX folder, and skip when
manimlib or TeX is missing. The failing formulas are the ones from the logged check failures.
"""
import json
import shutil
import subprocess
import sys
import tempfile
import textwrap
import types
import unittest
from importlib.util import find_spec
from pathlib import Path
from unittest import mock

RUNTIME = Path(__file__).resolve().parent / "runtime"
sys.path.insert(0, str(RUNTIME))
import texfix  # noqa: E402

REAL = bool(find_spec("manimlib") and shutil.which("latex") and shutil.which("dvisvgm"))

# chapters/03-perceptron-update of the "linear and nonlinear energy functions" lesson: the same
# shared colour table on every Tex, in the order the scene builds them. The last two crashed with
# `IndexError: list index out of range` in StringMobject.get_submob_indices_list_by_span.
SCRIPT = textwrap.dedent(R'''
    import json, sys
    patched = sys.argv[1] == "patched"
    from manimlib import *
    if patched:
        import voiceover  # a scene's `from voiceover import VoiceoverScene` is what installs the repair
    COLORS = {R"x": GREEN, R"y": WHITE, R"\hat{y}": YELLOW, R"e": RED, R"\theta": GREY_B, R"w_y": BLUE,
              R"w_{\hat{y}}": MAROON, R"b": TEAL, R"\eta": ORANGE, R"L": PINK, R"h": PURPLE, R"\hat{h}": PURPLE_A,
              R"U,\ c": BLUE_C, R"\sigma,\ \sigma'": ORANGE, R"\delta": GOLD, R"\nabla": GREY_A}
    out = {}

    def build(name, tex, **kw):
        try:
            out[name] = len(Tex(tex, **kw))
        except Exception as e:
            out[name] = type(e).__name__ + ": " + str(e).splitlines()[0]

    build("recap", R"\nabla_{w_y} e = -x", font_size=48, t2c=COLORS)
    build("A", R"e_{new} = -(w_y + \eta x)^\top x - (b_y + \eta)", font_size=40, t2c=COLORS)
    build("B", R"= -w_y^\top x - \eta x^\top x - b_y - \eta", font_size=40, t2c=COLORS)
    build("C", R"= -w_y^\top x - b_y - \eta (\|x\|^2 + 1)", font_size=40, t2c=COLORS)
    build("E_right", R"= e([x,\hat{y}]) + \eta (\|x\|^2 + 1)", font_size=38, t2c=COLORS)
    build("double_thick_space", R"u \ge 0, \;\; 0 \le v \le 1", font_size=36, t2c=COLORS)
    build("space_before_command", R"+ \; \mathbb{E}_q[\log p(z)]", font_size=36, t2c=COLORS)
    build("left_norm", R"\left\| x \right\|", font_size=36)
    build("lone_norm", R"\|x\|", font_size=36)
    build("thick_space_keeps_next_letter", R"a \; b", font_size=36)
    try:  # the writer picks a part of a formula that has \| in it, as chapters/05 does
        kl = Tex(R"R(Q) \le D_{KL}(Q\|P) + \log N", font_size=36, t2c=COLORS)
        out["select_kl"] = len(kl[R"D_{KL}(Q\|P)"][0])
    except Exception as e:
        out["select_kl"] = type(e).__name__ + ": " + str(e)
    build("real_mistake", R"\undefinedcommand{x} + 1", font_size=36, t2c=COLORS)  # a bug in the scene
    build("unbalanced", R"\frac{1}{2", font_size=36, t2c=COLORS)  # another
    print("RESULT" + json.dumps(out))
''')


def run_script(mode):
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        (work / "latex_cache").mkdir()
        (work / "custom_config.yml").write_text(json.dumps({"directories": {"cache": str(work / "cache"), "subdirs": {"latex_cache": str(work / "latex_cache")}}}))
        (work / "script.py").write_text(SCRIPT)
        env = {"PATH": __import__("os").environ["PATH"], "HOME": str(work), "PYTHONPATH": str(RUNTIME)}
        done = subprocess.run([sys.executable, "script.py", mode], cwd=work, env=env, capture_output=True, text=True, timeout=600)
    line = next((l for l in done.stdout.replace("\r", "\n").splitlines() if l.startswith("RESULT")), None)
    if line is None:
        raise AssertionError(done.stdout[-1500:] + done.stderr[-1500:])
    return json.loads(line[len("RESULT"):])


@unittest.skipUnless(REAL, "needs manimlib (from install.sh) and TeX")
class RealToolchainTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.patched = run_script("patched")

    def test_formulas_with_norms_and_double_spaces_build_and_keep_their_colours(self):
        for name in ("A", "B", "C", "E_right", "double_thick_space", "space_before_command", "left_norm", "lone_norm"):
            self.assertIsInstance(self.patched[name], int, f"{name}: {self.patched[name]}")

    def test_each_formula_is_its_own_picture_not_the_one_before(self):
        self.assertEqual(self.patched["lone_norm"], 3)  # the two bars and the x
        self.assertEqual(self.patched["thick_space_keeps_next_letter"], 2)  # `\;` no longer eats the b

    def test_a_part_of_a_formula_with_a_norm_in_it_can_be_selected(self):
        self.assertIsInstance(self.patched["select_kl"], int, self.patched["select_kl"])

    def test_a_real_latex_mistake_still_fails_and_says_why(self):
        # With a good formula built just before, ManimGL alone would have drawn that one instead.
        self.assertTrue(self.patched["real_mistake"].startswith("LatexError"), self.patched["real_mistake"])
        self.assertIn("Undefined control sequence", self.patched["real_mistake"])
        self.assertTrue(self.patched["unbalanced"].startswith(("LatexError", "ValueError")), self.patched["unbalanced"])

    def test_without_the_repair_the_logged_crash_comes_back(self):
        plain = run_script("plain")
        if not all(isinstance(plain[k], int) for k in ("recap", "A", "B")):
            self.skipTest("the formulas that should build first did not")
        if isinstance(plain["C"], int) and isinstance(plain["E_right"], int):
            self.skipTest("this ManimGL no longer reuses a stale picture, so there is nothing to repair")
        self.assertIn("IndexError", plain["C"] + plain["E_right"])


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.addCleanup(setattr, texfix, "_installed", texfix._installed)
        texfix._installed = False

    def test_does_nothing_before_manimlib_is_loaded(self):
        with mock.patch.dict(sys.modules):
            sys.modules.pop("manimlib", None)
            self.assertFalse(texfix.install())

    def test_does_nothing_for_a_stand_in_manimlib(self):
        with mock.patch.dict(sys.modules):
            # Hide any real manimlib an earlier test loaded, submodules included, or the stand-in would reach them.
            for name in [m for m in sys.modules if m == "manimlib" or m.startswith("manimlib.")]:
                del sys.modules[name]
            sys.modules["manimlib"] = types.ModuleType("manimlib")
            self.assertFalse(texfix.install())

    def test_voiceover_and_kit_ask_for_the_repair(self):
        text = (RUNTIME / "voiceover.py").read_text() + (RUNTIME / "kit.py").read_text()
        self.assertEqual(text.count("texfix.install()"), 3)  # voiceover at import and in __init__, kit at import

    def test_the_preamble_puts_back_the_maths_meanings(self):
        for command in (r"\;", r"\:", r"\!", r"\|"):
            self.assertIn(command, texfix.PREAMBLE_FIX)


if __name__ == "__main__":
    unittest.main()
