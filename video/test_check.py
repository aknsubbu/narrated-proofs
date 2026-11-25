"""check.py's reading of a project's files, and what it says about TeX that will not compile. The reading uses the standard library only: nothing is spoken or run. The TeX tests compile for real and skip without manimgl and TeX."""
import ast
import json
import os
import shutil
import tempfile
import unittest
import wave
from pathlib import Path
from unittest import mock

import build
import check as check_module
import texcheck
from check import Report, check, check_static, tidy, write_storyboard

SCRIPT = """# a comment
[intro]
Every line has a <mark name="slope"/>slope.

[outro]
That is all.
"""

SCENES = """from manimlib import *
from voiceover import VoiceoverScene


class Intro(VoiceoverScene, Scene):
    def construct(self):
        with self.voiceover("intro") as vo:
            self.play(Write(Text("Slope")), run_time=vo.until("slope"))
            self.wait(vo.remaining())


class Outro(VoiceoverScene, Scene):
    def construct(self):
        with self.voiceover("outro") as vo:
            self.wait(vo.remaining())
"""


class StaticCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.write(script=SCRIPT, scenes=SCENES)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, script=None, scenes=None, config=None):
        if script is not None:
            (self.root / "script.txt").write_text(script, encoding="utf-8")
        if scenes is not None:
            (self.root / "scenes.py").write_text(scenes, encoding="utf-8")
        config = {"voice": "af_heart", "scenes": ["Intro", "Outro"]} if config is None else config
        (self.root / "project.json").write_text(json.dumps(config), encoding="utf-8")

    def errors(self, **kw):
        result = check(self.root, static_only=True, **kw)
        return [e["message"] for e in result["errors"]], result

    def assertOneError(self, fragment, **kw):
        errors, _ = self.errors(**kw)
        self.assertEqual(len(errors), 1, errors)
        self.assertIn(fragment, errors[0])

    def test_a_sound_project_passes_and_reports_its_scenes_and_blocks(self):
        errors, result = self.errors()
        self.assertEqual(errors, [])
        self.assertTrue(result["ok"])
        self.assertEqual(result["scenes"], ["Intro", "Outro"])
        self.assertEqual(result["blocks"], [{"id": "intro", "words": 5}, {"id": "outro", "words": 3}])

    def test_sync_scenes_writes_the_classes_found_in_order(self):
        self.write(config={"voice": "af_heart", "scenes": []})
        self.assertOneError('"scenes" is empty')
        errors, _ = self.errors(sync_scenes=True)
        self.assertEqual(errors, [])
        saved = json.loads((self.root / "project.json").read_text())
        self.assertEqual(saved, {"voice": "af_heart", "scenes": ["Intro", "Outro"]})

    def test_problems_carry_their_file_line_and_block_for_an_editor(self):
        self.write(scenes=SCENES.replace('vo.until("slope")', 'vo.until("slpoe")'))
        _, result = self.errors()
        e = result["errors"][0]
        self.assertEqual((e["file"], e["line"]), ("scenes.py", 8))
        self.write(scenes=SCENES, script=SCRIPT.replace("That is all.", 'That is <b>all</b>.'))
        _, result = self.errors()
        e = result["errors"][0]
        self.assertEqual((e["file"], e["line"], e["block"]), ("script.txt", 5, "outro"))
        self.write(script=SCRIPT + "\n[spare]\nNot played.\n")
        _, result = self.errors()
        e = result["errors"][0]
        self.assertEqual((e["file"], e["line"], e["block"]), ("script.txt", 8, "spare"))

    def test_a_scene_failure_points_at_the_last_scenes_line_of_its_traceback(self):
        report = Report()
        report.files = {"script": "script.txt", "scenes": "scenes.py"}
        report.block_lines["scenes"] = {"intro": 7}
        report.error("Intro", 'Traceback (most recent call last):\n  File "/x/scenes.py", line 8, in construct\n  File "/v/manimlib/mobject.py", line 90, in f\nNameError: x')
        report.warn("Intro", "text overlaps", block="intro", scene="Intro")
        self.assertEqual({k: report.errors[0][k] for k in ("file", "line", "scene")}, {"file": "scenes.py", "line": 8, "scene": "Intro"})
        self.assertEqual({k: report.warnings[0][k] for k in ("file", "line", "block")}, {"file": "scenes.py", "line": 7, "block": "intro"})

    def test_a_syntax_error_names_its_line(self):
        self.write(scenes=SCENES.replace('self.wait(vo.remaining())\n\n\nclass', 'self.wait(vo.remaining()\n\n\nclass'))
        errors, _ = self.errors()
        self.assertTrue(errors[0].startswith("line "), errors)

    def test_an_unknown_block_or_mark_lists_the_real_ones(self):
        self.write(scenes=SCENES.replace('voiceover("outro")', 'voiceover("ending")'))
        errors, _ = self.errors()
        self.assertIn('names a block that is not in the script. Blocks: intro, outro', errors[0])
        self.assertIn('narration block "outro" is never played', errors[1])
        self.write(scenes=SCENES.replace('until("slope")', 'until("rise")'))
        self.assertOneError('block "intro" has no mark "rise". Its marks: slope')

    def test_a_block_played_twice_or_a_computed_id_is_an_error(self):
        self.write(scenes=SCENES.replace('voiceover("outro")', 'voiceover("intro")').replace("class Outro", "class Again"))
        errors, _ = self.errors(sync_scenes=True)
        self.assertIn('block "intro" is already played by Intro', errors[0])
        self.write(scenes=SCENES.replace('voiceover("outro")', 'voiceover(name)'))
        errors, _ = self.errors()
        self.assertIn("needs the block id written out as a string", errors[0])

    def test_scenes_may_only_import_what_they_need(self):
        self.write(scenes="import os\nimport subprocess as sp\nfrom urllib.request import urlopen\n" + SCENES)
        errors, _ = self.errors()
        self.assertEqual(len(errors), 3, errors)
        self.assertIn("importing os is not allowed", errors[0])
        self.write(scenes=SCENES + "\nopen('/etc/passwd')\nx = ().__class__\n")
        errors, _ = self.errors()
        self.assertEqual(len(errors), 2, errors)
        self.assertIn("open is not allowed", " ".join(errors))
        self.assertIn("__class__ is not allowed", " ".join(errors))

    def test_strict_rules_for_scenes_a_model_wrote(self):
        self.assertEqual(self.errors(strict=True)[0], [], "an ordinary generated scene passes")
        for line, fragment in [
            ("import sys", "importing sys is not allowed"),
            ("from pathlib import Path", "importing pathlib is not allowed"),
            ("os.getcwd()", "os is not allowed"),
            ("import subprocess as sp", "importing subprocess is not allowed"),
            ("subprocess.run(['ls'])", "subprocess is not allowed"),
            ("getattr(np, 'lo' + 'ad')", "getattr is not allowed"),
            ("np.load('x.npy')", ".load is not allowed"),
            ("np.savetxt('x', [1])", ".savetxt is not allowed"),
            ("x = '__subclasses__'", "double-underscore attribute"),
            ("vars(np)", "vars is not allowed"),
        ]:
            self.write(scenes=SCENES + "\n" + line + "\n")
            errors, _ = self.errors(strict=True)
            self.assertTrue(any(fragment in e for e in errors), (line, errors))
        # A hand-written project may still find its own files.
        self.write(scenes="import sys\nfrom pathlib import Path\n" + SCENES)
        self.assertEqual(self.errors()[0], [])

    def test_sp_is_free_for_maths_but_subprocess_stays_out(self):
        # A standard deviation called sp (sigma_p) is ordinary; the name alone reaches nothing.
        maths = "def kl_gauss(mq, sq, mp, sp):\n    return math.log(sp / sq) + (sq**2 + (mq - mp) ** 2) / (2 * sp**2) - 0.5\n\nsp = 2.0\nkl_gauss(0, 1, 0, sp)\n"
        self.write(scenes="import math\n" + SCENES + "\n" + maths)
        self.assertEqual(self.errors(strict=True)[0], [])
        # Importing the module under that name is still refused, by the import list.
        self.write(scenes="import subprocess as sp\n" + SCENES + "\nsp.run(['ls'])\n")
        errors, _ = self.errors(strict=True)
        self.assertEqual(len(errors), 1, errors)
        self.assertIn("importing subprocess is not allowed", errors[0])

    def test_script_problems_are_reported(self):
        self.write(script="Hello before any block\n")
        errors, _ = self.errors()
        self.assertIn("text before the first [block-id] line", errors[0])
        self.write(script=SCRIPT.replace("That is all.", "That is <b>all</b>."))
        self.assertOneError("has a tag that is not a mark")
        self.write(script=SCRIPT.replace("slope.", 'slope <mark name="slope"/>again.'))
        self.assertOneError('uses the mark name "slope" more than once')

    def test_a_file_with_no_scene_classes_or_a_wrong_base_order(self):
        self.write(scenes="from manimlib import *\n")
        errors, _ = self.errors()
        self.assertIn("no scene classes found", errors[0])
        self.write(scenes=SCENES.replace("Intro(VoiceoverScene, Scene)", "Intro(Scene, VoiceoverScene)"))
        self.assertOneError("must list VoiceoverScene first")

    def test_project_json_listing_a_missing_scene(self):
        self.write(config={"scenes": ["Intro", "Nope"]})
        self.assertOneError("lists Nope, which is not a scene class")

    def test_a_missing_project_file_is_an_error_not_a_crash(self):
        (self.root / "project.json").write_text("{not json", encoding="utf-8")
        report = Report()
        self.assertEqual(check_static(self.root, report), (None, None, None))
        self.assertIn("cannot be read", report.errors[0]["message"])


class PromptExampleTest(unittest.TestCase):
    """The worked example in the lesson writer's prompt is what Claude imitates, so it must stay valid."""

    def test_the_example_shown_to_claude_passes_the_static_check(self):
        example = Path(__file__).resolve().parent.parent / "tts-studio" / "author" / "prompts" / "example"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("script.txt", "scenes.py"):
                (root / name).write_text((example / name).read_text(encoding="utf-8"), encoding="utf-8")
            (root / "project.json").write_text('{"voice": "af_heart", "scenes": []}', encoding="utf-8")
            result = check(root, static_only=True, sync_scenes=True, strict=True)
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["scenes"], ["LossBowl", "ChainRule"])
        self.assertEqual([b["id"] for b in result["blocks"]], ["bowl", "setup", "chain", "links", "result"])


class TidyTest(unittest.TestCase):
    def test_keeps_the_traceback_and_drops_colour_and_progress_bars(self):
        noisy = (
            "\x1b[32mManimGL v1.7.2\x1b[0m\n"
            "Intro.mp4 0 WriteText : : 25it [00:00, 61.94it/s]\rIntro.mp4 1 Wait : : 44it [00:00, 80it/s]\n"
            "\n"
            "Traceback (most recent call last):\n"
            '  File "scenes.py", line 9, in construct\n'
            "NameError: name 'MathTex' is not defined\n"
        )
        self.assertEqual(
            tidy(noisy),
            "ManimGL v1.7.2\nTraceback (most recent call last):\n"
            '  File "scenes.py", line 9, in construct\n'
            "NameError: name 'MathTex' is not defined",
        )
        self.assertEqual(tidy("a\nb\nc\nd", limit=2), "c\nd")


class StoryboardFileTest(unittest.TestCase):
    """build/check/storyboard.json, from what each scene reported while it was checked."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "script.txt").write_text(SCRIPT, encoding="utf-8")
        (self.root / "scenes.py").write_text(SCENES, encoding="utf-8")
        self.config = {"script": "script.txt", "scenes_file": "scenes.py", "scenes": ["Intro", "Outro"]}
        self.manifest = {
            "order": ["intro", "outro"],
            "blocks": {
                "intro": {"wav": "audio/intro-1.wav", "duration": 2.5, "marks": {"slope": 1.1}, "text": "Every line has a slope."},
                "outro": {"wav": "audio/outro-2.wav", "duration": 1.25, "marks": {}, "text": "That is all."},
            },
        }

    def test_each_block_gets_its_narration_stills_and_problems(self):
        intro = {
            "blocks": [{"id": "intro", "start": 0.2, "duration": 2.5}],
            "stills": [
                {"block": "intro", "mark": "slope", "file": "Intro-intro--slope.png", "at": 1.1},
                {"block": "intro", "mark": None, "file": "Intro-intro.png", "at": 2.5},
                {"block": None, "mark": None, "file": "Intro-end.png", "at": None},
            ],
            "issues": [
                {"kind": "layout", "message": "text overlaps", "block": "intro", "scene": "Intro"},
                {"kind": "layout", "message": "off the edge in the last frame", "block": None, "scene": "Intro"},
            ],
        }
        board = write_storyboard(self.root, self.config, self.manifest, {"Intro": (intro, None), "Outro": (None, "NameError: Foo")})
        saved = json.loads((self.root / "build" / "check" / "storyboard.json").read_text())
        self.assertEqual(saved, board)
        first = board["scenes"][0]
        self.assertEqual(first["end"], "Intro-end.png")
        self.assertEqual(first["issues"], [{"kind": "layout", "message": "off the edge in the last frame"}])
        block = first["blocks"][0]
        self.assertEqual(block["text"], 'Every line has a <mark name="slope"/>slope.')
        self.assertEqual((block["start"], block["duration"], block["marks"]), (0.2, 2.5, {"slope": 1.1}))
        self.assertEqual([x["file"] for x in block["stills"]], ["Intro-intro--slope.png", "Intro-intro.png"])
        self.assertEqual(block["issues"], [{"kind": "layout", "message": "text overlaps"}])
        # A scene that failed before drawing anything still lists the blocks it would play.
        failed = board["scenes"][1]
        self.assertEqual(failed["error"], "NameError: Foo")
        self.assertEqual([b["id"] for b in failed["blocks"]], ["outro"])
        self.assertEqual(failed["blocks"][0]["stills"], [])
        self.assertEqual(board["unplayed"], [])
        self.assertEqual(board["duration"], 3.75)


TEX_SCENES = r'''from manimlib import *
from voiceover import VoiceoverScene

def T(s, size=44):
    return Tex(s, font_size=size, t2c={R"\mu": BLUE})


class Intro(VoiceoverScene, Scene):
    def construct(self):
        with self.voiceover("intro") as vo:
            ok = Tex(R"x^2 + y^2")
            bar = T(R"D(q \| p) = \notdefined")
            typo = Tex(R"\hatt{x}")
            self.wait(vo.remaining())
'''


class TexStringsTest(unittest.TestCase):
    """Finding the TeX written out in a scenes.py. Only reads the source; nothing is compiled."""

    def found(self, source):
        return [(f["line"], f["cls"], f["strings"], f["via"]) for f in texcheck.tex_strings(ast.parse(source))]

    def test_strings_written_out_are_found_with_their_lines(self):
        self.assertEqual(self.found('a = Tex("x")\nb = TexText("a" "b")\nc = Tex("p" + "q", "r")\n'), [
            (1, "Tex", ["x"], None), (2, "TexText", ["ab"], None), (3, "Tex", ["pq", "r"], None),
        ])

    def test_strings_passed_to_a_helper_that_builds_a_tex_are_found_at_the_call(self):
        source = 'def T(s, size=1):\n    return Tex(s, font_size=size)\n\nclass A:\n    def m(self):\n        T(R"a\\|b")\n        T(s="c")\n'
        self.assertEqual(self.found(source), [(6, "Tex", ["a\\|b"], "T"), (7, "Tex", ["c"], "T")])

    def test_computed_strings_and_changed_templates_are_left_alone(self):
        for source in [
            'Tex(f"x{n}")', 'Tex(name)', 'Tex("a" + name)', 'Tex(*parts)', 'Tex("x", additional_preamble="\\\\usepackage{foo}")',
            'Text("x")', 'def T(s):\n    s = s + "!"\n    return Tex(s)\nT("a")',
            'def T(s):\n    return Tex(s.replace("a", "b"))\nT("a")',
        ]:
            self.assertEqual(self.found(source), [], source)

    def test_a_name_defined_twice_is_not_trusted_as_a_helper(self):
        source = 'def T(s):\n    return Tex(s)\ndef T(s):\n    return Text(s)\nT("a")'
        self.assertEqual(self.found(source), [])


class TexFailureMessageTest(unittest.TestCase):
    """What the writer is told when a scene fails on TeX, from a failure's output and the files manim leaves."""

    OUTPUT = (
        "Writing D_{\\mathrm{KL}}(q \\| p(z \\mid x)) = -\\int q(z) \\log \\frac{p(z \\mid x)}...\r\n"
        "Traceback (most recent call last):\n"
        '  File "/v/manimlib/scene/scene.py", line 157, in run\n'
        '  File "/p/chapters/03/scenes.py", line 79, in construct\n'
        '    L0 = tx(R"D_{\\mathrm{KL}}(q \\| p)", fs)\n'
        "         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\n"
        '  File "/p/chapters/03/scenes.py", line 8, in tx\n'
        "    return Tex(s, font_size=fs, t2c=COLORS)\n"
        '  File "/v/manimlib/utils/tex_file_writing.py", line 135, in full_tex_to_svg\n'
        "manimlib.utils.tex_file_writing.LatexError: Argument of \\T3\\| has an extra }.\n"
        "<inserted text>\n"
    )
    BODY = "D_{\\mathrm{KL}}(q \\| p(z \\mid x)) = -\\int q(z) \\log \\frac{p(z \\mid x)}{q(z)} \\, dz"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        work = self.root / "build" / "latex_cache"
        work.mkdir(parents=True)
        # Manim wraps the string in align*, and colours the parts named in t2c.
        coloured = self.BODY.replace("\\mathrm{KL}", "{{\\color[RGB]{1, 2, 3}\\mathrm{KL}}}", 1)
        (work / "working.tex").write_text(f"\\documentclass{{standalone}}\n\\begin{{document}}\n\\centering\n\\begin{{align*}}\n{coloured}\n\\end{{align*}}\n\\end{{document}}\n")
        (work / "working.log").write_text(
            "This is pdfTeX\n(./working.tex\n! Argument of \\T3\\| has an extra }.\n<inserted text> \n"
            "                \\par \nl.8 D_{\\mathrm{KL}}(q \\|\n                         p(z \\mid x)\n"
            "Runaway argument?\n")

    def test_it_names_the_call_site_the_whole_string_and_texs_error(self):
        message, extra = texcheck.explain_failure(self.root, "scenes.py", self.OUTPUT, "Derive")
        self.assertEqual(extra, {"file": "scenes.py", "line": 79, "scene": "Derive"})
        self.assertIn("scenes.py line 79", message)
        self.assertIn("built in tx() at line 8", message)
        self.assertIn("L0 = tx(", message)
        self.assertIn(self.BODY, message, "the whole string, with manim's colour markup taken off, not the 70 characters it printed")
        self.assertNotIn("\\color", message)
        self.assertIn("! Argument of \\T3\\| has an extra }.", message)
        self.assertIn("Vert", message, "the way out is said, since TeX's own words do not say it")

    def test_a_string_already_reported_ahead_of_the_scenes_is_not_said_again(self):
        report = Report()
        report.tex_reported = {self.BODY: 12}
        message, _ = texcheck.explain_failure(self.root, "scenes.py", self.OUTPUT, "Derive", report)
        self.assertIn("already reported at scenes.py line 12", message)
        self.assertNotIn("TeX error", message)

    def test_a_failure_that_is_not_tex_is_left_to_tidy(self):
        self.assertIsNone(texcheck.explain_failure(self.root, "scenes.py", "Traceback\nNameError: x\n", "Derive"))

    def test_without_manims_files_it_still_says_what_it_can(self):
        (self.root / "build" / "latex_cache" / "working.tex").unlink()
        (self.root / "build" / "latex_cache" / "working.log").unlink()
        message, extra = texcheck.explain_failure(self.root, "scenes.py", self.OUTPUT, "Derive")
        self.assertEqual(extra["line"], 79)
        self.assertIn("D_{\\mathrm{KL}}(q \\| p(z \\mid x))", message)
        self.assertIn("Argument of \\T3\\| has an extra }", message)

    def test_colour_markup_is_taken_off_without_touching_the_strings_own_braces(self):
        self.assertEqual(texcheck.plain_tex("{{\\color[RGB]{1, 2, 3}\\mu_{k}}} + \\{x\\} {{\\color[RGB]{4, 5, 6}a}}"), "\\mu_{k} + \\{x\\} a")

    def test_errors_tex_words_badly_get_advice(self):
        for error, fragment in [
            ("! Undefined control sequence.\nl.3 \\hatt", "\\hatt is not a command"),
            ("! Missing $ inserted.", "TexText"),
            ("! Misplaced alignment tab character &.", "\\&"),
            ("! LaTeX Error: Unicode character \u2211 (U+2211)", "unicode"),
            ("! Too many }'s.", "braces"),
        ]:
            self.assertIn(fragment, texcheck.hint(error), error)
        self.assertEqual(texcheck.hint("! Something else entirely."), "")


def _can_compile_tex():
    return Path(build.MANIMGL).exists() and shutil.which("latex") and shutil.which("dvisvgm")


@unittest.skipUnless(_can_compile_tex(), "needs manimgl and TeX (set $MANIMGL if it is not in ../.venv)")
class TexCompileTest(unittest.TestCase):
    """The same checks against real TeX, under the sandbox, in a cache of their own."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir()
        patch = mock.patch.dict(os.environ, {"VIDEO_SCENE_CACHE": str(Path(self.tmp.name) / "cache")})
        patch.start()
        self.addCleanup(patch.stop)
        self.config = {"scenes_file": "scenes.py"}
        self.report = Report()
        self.report.files = {"scenes": "scenes.py"}

    def run_literals(self, scenes):
        (self.root / "scenes.py").write_text(scenes, encoding="utf-8")
        texcheck.check_literals(self.root, self.config, self.report)
        return self.report.errors

    def test_a_good_string_passes(self):
        self.assertEqual(self.run_literals('a = Tex(R"x^2 + \\frac{a}{b}")\nb = TexText("plain words")\nc = Tex(R"a & b \\\\ c & d")\n'), [])

    def test_every_bad_string_is_reported_at_once_with_its_line_string_and_tex_error(self):
        errors = self.run_literals(TEX_SCENES)
        self.assertEqual([e["line"] for e in errors], [12, 13], errors)
        self.assertEqual({e["file"] for e in errors}, {"scenes.py"})
        bar, typo = (e["message"] for e in errors)
        self.assertIn("passed to T()", bar)
        self.assertIn("D(q \\| p) = \\notdefined", bar)
        # texfix gives \| back its maths meaning in the probe as in a scene, so only the real mistake is reported.
        self.assertIn("! Undefined control sequence.", bar)
        self.assertIn("\\notdefined is not a command", bar)
        self.assertNotIn("T3", bar)
        self.assertIn(R"\hatt{x}", typo)
        self.assertIn("! Undefined control sequence.", typo)
        self.assertIn("\\hatt is not a command", typo)

    def test_a_bad_string_after_a_good_one_is_still_caught(self):
        # manim treats a leftover .dvi as a successful compile, so the second would pass and draw the first.
        errors = self.run_literals('a = Tex(R"x^2")\nb = Tex(R"\\hatt{x}")\n')
        self.assertEqual([e["line"] for e in errors], [2])

    def test_a_string_used_twice_is_one_error_naming_both_lines(self):
        errors = self.run_literals('a = Tex(R"\\hatt{x}")\nb = Tex(R"\\hatt{x}")\n')
        self.assertEqual(len(errors), 1)
        self.assertIn("also at line(s) 2", errors[0]["message"])

    def test_the_scene_is_never_run_only_its_strings_are_read(self):
        marker = Path(self.tmp.name) / "ran"
        scenes = f'from pathlib import Path\nPath({str(marker)!r}).write_text("ran")\na = Tex(R"x")\n'
        self.assertEqual(self.run_literals(scenes), [])
        self.assertFalse(marker.exists())

    def test_shell_escape_in_a_string_is_no_more_than_manim_allows(self):
        marker = Path(self.tmp.name) / "shell"
        self.run_literals(f'a = Tex(R"\\immediate\\write18{{touch {marker}}} x")\n')
        self.assertFalse(marker.exists(), "TeX's restricted shell escape runs only programs on its short list")

    def test_a_scene_that_fails_on_tex_reports_the_call_the_string_and_the_error(self):
        # Computed strings cannot be read ahead of time; the scene's own run reports them. The bad one
        # is the first TeX the scene compiles: manim lets a bad string after a good one pass (see above).
        scenes = (
            "from manimlib import *\nfrom voiceover import VoiceoverScene\n\n\n"
            "class Intro(VoiceoverScene, Scene):\n    def construct(self):\n"
            '        with self.voiceover("intro") as vo:\n'
            '            typo = Tex(f"\\\\hatt{1+1} + \\\\mu", t2c={R"\\mu": BLUE})\n'
            "            self.wait(vo.remaining())\n"
        )
        (self.root / "scenes.py").write_text(scenes, encoding="utf-8")
        build_dir = self.root / "build"
        (build_dir / "audio").mkdir(parents=True)
        with wave.open(str(build_dir / "audio" / "intro.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(24000)
            w.writeframes(b"\0\0" * 24000)
        (build_dir / "manifest.json").write_text(json.dumps({"order": ["intro"], "blocks": {"intro": {"wav": "audio/intro.wav", "duration": 1.0, "marks": {}, "text": "x"}}}))
        check_module.try_scene(self.root, {"scenes_file": "scenes.py"}, "Intro", self.report)
        e = self.report.errors[-1]
        self.assertEqual((e["file"], e["line"], e["scene"]), ("scenes.py", 8, "Intro"))
        self.assertIn("typo = Tex(f", e["message"])
        self.assertIn("\\hatt2", e["message"])
        self.assertIn("! Undefined control sequence.", e["message"])
        self.assertNotIn("Traceback", e["message"])


if __name__ == "__main__":
    unittest.main()
