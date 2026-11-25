"""autofix.py: the mistakes fixed without asking a model. Standard library only."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from autofix import closest, fix_source

HERE = Path(__file__).resolve().parent

SCENE = '''from manimlib import *
from voiceover import VoiceoverScene


class Intro(VoiceoverScene, Scene):
    def construct(self):
        axes = Axes((0, 4), (0, 4))
        eq = MathTex(R"\\hat{y}").set_color(GRAY_B)
        with self.voiceover("intro") as vo:
            self.play(Create(axes), run_time=vo.until("slpoe"))
            graph = axes.plot(lambda x: x).set_stroke(LIGHT_GRAY)
            self.play(self.camera.frame.animate.scale(0.5), ShowCreation(graph))
'''


class FixSourceTest(unittest.TestCase):
    def test_names_from_the_other_manim_become_manimgl_names(self):
        fixed, fixes = fix_source(SCENE)
        self.assertIn('Tex(R"\\hat{y}").set_color(GREY_B)', fixed)
        self.assertIn("self.play(ShowCreation(axes)", fixed)
        self.assertIn("axes.get_graph(lambda x: x).set_stroke(GREY_B)", fixed)
        self.assertIn("self.play(self.frame.animate.scale(0.5), ShowCreation(graph))", fixed)
        self.assertEqual(len(fixes), 6)
        self.assertEqual(fix_source(fixed), (fixed, []))  # nothing left to fix

    def test_a_shade_of_pink_or_orange_becomes_the_colour(self):
        source = 'COLORS = {R"a": PINK_B, R"b": ORANGE_C, R"c": LIGHT_PINK, R"d": BLUE_B}\nx = Dot(color=PINK_E)\n'
        fixed, fixes = fix_source(source)
        self.assertEqual(fixed, 'COLORS = {R"a": PINK, R"b": ORANGE, R"c": LIGHT_PINK, R"d": BLUE_B}\nx = Dot(color=PINK)\n')
        self.assertEqual(len(fixes), 3)
        own = "PINK_B = '#ff88aa'\nx = PINK_B\n"
        self.assertEqual(fix_source(own), (own, []), "a name the file defines is left alone")

    def test_a_name_error_that_suggests_the_colour_without_its_shade_is_fixed(self):
        # BLACK_B is in no rename rule: the report's own NameError is what says it.
        errors = [{"where": "Hook", "message": "Traceback (most recent call last):\nNameError: name 'BLACK_B' is not defined. Did you mean: 'BLACK'?"}]
        fixed, fixes = fix_source("x = Dot(color=BLACK_B)\ny = BLACK_B\n", errors)
        self.assertEqual(fixed, "x = Dot(color=BLACK)\ny = BLACK\n")
        self.assertEqual(len(fixes), 1)
        # Any other suggestion is a guess and is left to the writer.
        for name, hint in [("LIGHT_BLUE", "BLUE_A"), ("BLUE_F", "BLUE_E"), ("sloap", "slope")]:
            errors = [{"where": "Hook", "message": f"NameError: name '{name}' is not defined. Did you mean: '{hint}'?"}]
            source = f"x = {name}\n"
            self.assertEqual(fix_source(source, errors), (source, []))

    def test_calls_written_the_manim_community_way_are_rewritten(self):
        # Each is from a check report in the library.
        source = (
            "self.play(FadeOut(*panel), *focus((2, 4)), run_time=0.6)\n"
            "self.play(FadeOut(*self.mobjects), run_time=0.8)\n"
            "self.play(FadeOut(VGroup(*self.mobjects)), FadeIn(row))\n"
            "nl = NumberLine((-3, 3, 1), length=9, include_numbers=True).move_to(UP * 1.5)\n"
        )
        fixed, fixes = fix_source(source)
        self.assertEqual(
            fixed,
            "self.play(FadeOut(Group(*panel)), *focus((2, 4)), run_time=0.6)\n"
            "self.play(FadeOut(Group(*self.mobjects)), run_time=0.8)\n"
            "self.play(FadeOut(Group(*self.mobjects)), FadeIn(row))\n"
            "nl = NumberLine((-3, 3, 1), width=9, include_numbers=True).move_to(UP * 1.5)\n",
        )
        self.assertEqual(len(fixes), 3)
        self.assertEqual(fix_source(fixed), (fixed, []))

    def test_calls_that_are_not_that_mistake_are_left_alone(self):
        for source in [
            "self.play(FadeOut(*panel, shift=UP))\n",  # more arguments: not a guess to make
            "self.play(FadeOut(a), FadeIn(*b, c))\n",
            "nl = NumberLine((-3, 3), tip_config=dict(length=0.2))\n",  # a nested keyword
            "nl = NumberLine((-3, 3), width=9)\nx = Line(a, b, length=2)\n",
            'label = Text("FadeOut(*a) NumberLine(length=3)")\n',
            "# don't FadeOut(*a) or NumberLine(length=3)\nx = 1\n",
            'doc = """FadeOut(*a)"""\n',
        ]:
            self.assertEqual(fix_source(source), (source, []), source)

    def test_the_colour_rules_match_the_installed_manimlib(self):
        try:
            import manimlib.constants as c
        except ImportError:
            self.skipTest("manimlib is not installed")
        have = {n for n in dir(c) if n.isupper() and str(getattr(c, n)).startswith("#")}
        for colour in ("PINK", "ORANGE"):
            self.assertIn(colour, have)
            self.assertFalse({f"{colour}_{s}" for s in "ABCDE"} & have, f"{colour} has shades now; drop its rename rule")
        for colour in ("BLUE", "GREEN", "YELLOW", "RED", "PURPLE", "TEAL", "GREY", "GOLD", "MAROON"):
            self.assertTrue({f"{colour}_{s}" for s in "ABCDE"} <= have, colour)

    def test_a_name_the_file_defines_itself_is_left_alone(self):
        source = "GRAY = '#888888'\nclass Create(Animation):\n    pass\nx = Create(GRAY)\n"
        self.assertEqual(fix_source(source), (source, []))

    def test_a_mistyped_mark_or_block_is_corrected_on_the_line_the_check_named(self):
        errors = [
            {"where": "scenes.py", "message": 'line 10: block "intro" has no mark "slpoe". Its marks: rise, slope'},
            {"where": "scenes.py", "message": 'line 9: self.voiceover("Intro") names a block that is not in the script. Blocks: intro, outro'},
        ]
        fixed, fixes = fix_source(SCENE.replace('voiceover("intro")', 'voiceover("Intro")'), errors)
        self.assertIn('vo.until("slope")', fixed)
        self.assertIn('self.voiceover("intro")', fixed)
        self.assertIn('line 10: mark "slpoe" in block "intro" is "slope"', fixes)

    def test_no_guess_when_two_names_are_equally_close_or_none_is(self):
        self.assertIsNone(closest("rise", ["rose", "rice"]))
        self.assertIsNone(closest("gradient", ["slope", "rise"]))
        self.assertEqual(closest("Slope", ["slope", "rise"]), "slope")


class CommandTest(unittest.TestCase):
    def test_it_rewrites_scenes_py_and_says_what_it_did(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "project.json").write_text(json.dumps({"scenes_file": "scenes.py"}))
            (root / "scenes.py").write_text(SCENE)
            report = root / "check.json"
            report.write_text(json.dumps({"errors": [{"where": "scenes.py", "message": 'line 10: block "intro" has no mark "slpoe". Its marks: slope'}]}))
            done = subprocess.run([sys.executable, str(HERE / "autofix.py"), str(root), "--report", str(report)], capture_output=True, text=True, check=True)
            result = json.loads(done.stdout)
            self.assertTrue(result["changed"])
            self.assertIn('vo.until("slope")', (root / "scenes.py").read_text())
            done = subprocess.run([sys.executable, str(HERE / "autofix.py"), str(root)], capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(done.stdout), {"changed": False, "fixes": []})


if __name__ == "__main__":
    unittest.main()
