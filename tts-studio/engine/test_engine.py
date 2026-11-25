"""Text handling and timing tests. They need only the standard library, not the model."""
import importlib.util
import unittest
from types import SimpleNamespace

from kokoro_engine import (
    CLAUSE_GAP, LANGUAGES, LINE_PAUSE, SENTENCE_PAUSES, MAX_CPU_THREADS, PARAGRAPH_PAUSE, SAMPLE_RATE, clean, cpu_threads,
    TRIM_FRAME, cached_snapshot, speak_segments, speech_bounds, split_segments, trim_speech,
)

SENTENCE = "This is a perfectly ordinary sentence about nothing in particular."


class CleanTest(unittest.TestCase):
    def test_strips_markdown_but_keeps_words_and_snake_case(self):
        md = (
            "# Title\n\nHello **bold** and _soft_ with [a link](http://x.com) and `code`.\n\n"
            "- item one\n- item two\n\n```js\nignore()\n```\n\nuse my_snake_case_name here"
        )
        self.assertEqual(
            clean(md),
            "Title\n\nHello bold and soft with a link and code.\n\nitem one\nitem two\n\nuse my_snake_case_name here",
        )

    def test_keeps_pronunciation_hints_but_strips_ordinary_links(self):
        self.assertEqual(
            clean("Say [Kokoro](/kˈOkəɹO/) on [this page](/docs/intro)."),
            "Say [Kokoro](/kˈOkəɹO/) on this page.",
        )

    def test_can_leave_markdown_alone(self):
        self.assertEqual(clean("**x**\r\n\r\n\r\n\r\ny", strip_markdown=False), "**x**\n\ny")


class SplitTest(unittest.TestCase):
    def test_short_text_is_one_segment_with_no_trailing_pause(self):
        self.assertEqual(split_segments("One short paragraph.", 400), [("One short paragraph.", 0.0)])

    def test_respects_the_limit_and_never_loses_words(self):
        text = " ".join([SENTENCE] * 200)
        for limit in sorted({lang["limit"] for lang in LANGUAGES.values()}):
            segments = split_segments(text, limit)
            self.assertGreater(len(segments), 1)
            self.assertTrue(all(len(s) <= limit for s, _ in segments))
            self.assertEqual(" ".join(s for s, _ in segments).split(), text.split())

    def test_paragraphs_get_a_longer_pause_than_lines(self):
        segments = split_segments("First paragraph.\n\nitem one\nitem two\n\nLast.", 400)
        self.assertEqual([s for s, _ in segments], ["First paragraph.", "item one", "item two", "Last."])
        self.assertEqual([p for _, p in segments], [PARAGRAPH_PAUSE, LINE_PAUSE, PARAGRAPH_PAUSE, 0.0])

    def test_each_sentence_is_a_segment_with_a_pause_for_how_it_ended(self):
        segments = split_segments("It rises. Does it fall? No! Wait\u2026 Yes.", 400)
        self.assertEqual([s for s, _ in segments], ["It rises.", "Does it fall?", "No!", "Wait\u2026", "Yes."])
        self.assertEqual([p for _, p in segments][:-1], [SENTENCE_PAUSES[c] for c in ".?!\u2026"])
        self.assertGreater(PARAGRAPH_PAUSE, max(SENTENCE_PAUSES.values()))

    def test_abbreviations_and_lowercase_starts_do_not_end_a_sentence(self):
        text = "The slope, e.g. rise over run, is shown in Fig. 2 by Dr. Lee. Then x = 3. and so on. Done."
        self.assertEqual([s for s, _ in split_segments(text, 400)], [
            "The slope, e.g. rise over run, is shown in Fig. 2 by Dr. Lee.",
            "Then x = 3. and so on.",
            "Done.",
        ])

    def test_a_long_sentence_is_cut_with_only_a_clause_gap_inside_it(self):
        segments = split_segments(" ".join(f"w{i}" for i in range(300)) + ". Next.", 220)
        self.assertTrue(all(p == CLAUSE_GAP for _, p in segments[:-2]))
        self.assertEqual(segments[-2][1], SENTENCE_PAUSES["."])

    def test_pauses_follow_the_chosen_table(self):
        # Variant E, chosen by ear: full stops 0.55 s, questions 0.65 s, and a paragraph longer than either.
        self.assertEqual((SENTENCE_PAUSES["."], SENTENCE_PAUSES["?"], SENTENCE_PAUSES["…"]), (0.55, 0.65, 0.65))
        self.assertEqual((LINE_PAUSE, PARAGRAPH_PAUSE, CLAUSE_GAP), (0.35, 0.90, 0.25))

    def test_a_line_ending_in_a_colon_pauses_less_than_a_full_stop(self):
        segments = split_segments("Two cases:\nthe first.\nthe second", 400)
        self.assertEqual([p for _, p in segments], [SENTENCE_PAUSES[":"], SENTENCE_PAUSES["."], 0.0])
        self.assertLess(SENTENCE_PAUSES[":"], SENTENCE_PAUSES["."])

    def test_hard_wrapped_prose_is_rejoined(self):
        wrapped = (
            "This paragraph was wrapped at a fixed column by an editor, so\n"
            "its lines end in the middle of sentences and must be rejoined."
        )
        self.assertEqual(len(split_segments(wrapped, 400)), 1)

    def test_huge_unpunctuated_run_is_split_at_spaces(self):
        text = " ".join(f"w{i}" for i in range(2000))
        segments = split_segments(text, 220)
        self.assertTrue(all(len(s) <= 220 for s, _ in segments))
        self.assertEqual(sum(len(s.split()) for s, _ in segments), 2000)

    def test_chinese_and_japanese_sentences_split_without_spaces(self):
        text = "你好。" * 100
        segments = split_segments(text, 80)
        self.assertTrue(all(len(s) <= 80 for s, _ in segments))
        self.assertEqual("".join(s.replace(" ", "") for s, _ in segments), text)


class FakeAudio(list):
    """Stands in for a torch tensor: .detach().cpu().numpy() gives back the samples."""

    def detach(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self


SR = SAMPLE_RATE


def tone(seconds, speech=None, blip=None):
    """Samples of `seconds`: silence, with 0.1 inside `speech` = (start, end) in seconds, and an optional
    5 ms `blip` = (at, level) of noise in the silence, like the pre-roll some voices have."""
    n = int(round(seconds * SR))
    x = [0.0] * n
    if speech:
        a, b = (int(round(t * SR)) for t in speech)
        x[a:b] = [0.1] * (b - a)
    if blip:
        at, level = int(round(blip[0] * SR)), blip[1]
        x[at:at + 120] = [level] * 120
    return x


def result(seconds, tokens=(), phonemes="", audio=True, speech=None, blip=None):
    """A Kokoro result. With no `speech` its audio is all silence, which no trim can find speech in."""
    toks = None if tokens is None else [SimpleNamespace(text=t, start_ts=a, end_ts=b) for t, a, b in tokens]
    return SimpleNamespace(
        audio=FakeAudio(tone(seconds, speech, blip)) if audio else None,
        tokens=toks,
        phonemes=phonemes,
    )


class FakePipeline:
    """Answers each segment with the results queued for it, in order."""

    def __init__(self, per_segment):
        self.per_segment = list(per_segment)
        self.calls = []

    def __call__(self, text, voice, speed, split_pattern):
        self.calls.append((text, voice, speed, split_pattern))
        return iter(self.per_segment.pop(0))


def run(per_segment, segments, speed=1.0, lead=0.0, tail=0.0):
    """speak_segments over fakes. Returns what it said and wrote, with the whole output in `stream`."""
    written, padded, stream = [], [], []

    def write(a):
        written.append(len(a))
        stream.extend(a)

    def pad(n):
        padded.append(n)
        stream.extend([0.0] * n)

    pipe = FakePipeline(per_segment)
    samples, truncated, words = speak_segments(pipe, segments, "af_heart", speed, write=write, pad=pad, lead=lead, tail=tail)
    return SimpleNamespace(samples=samples, truncated=truncated, words=words, written=written, padded=padded, stream=stream, pipe=pipe)


def silences(stream):
    """(leading, [gaps between stretches of sound], trailing) in samples: exact for the fakes, whose sound is 0.1."""
    loud = [i for i, v in enumerate(stream) if v != 0.0]
    if not loud:
        return len(stream), [], 0
    gaps = [b - a - 1 for a, b in zip(loud, loud[1:]) if b - a > 1]
    return loud[0], gaps, len(stream) - loud[-1] - 1


SPOKEN = dict(speech=(0.30, 1.10))  # Kokoro's shape: 0.3 s before the speech, 0.4 s after, in a 1.5 s result


class TrimTest(unittest.TestCase):
    def test_speech_bounds_find_the_first_and_last_loud_frame(self):
        self.assertEqual(speech_bounds(tone(1.5, (0.30, 1.10))), (7200, 26400))
        self.assertIsNone(speech_bounds([0.0] * 2400))

    def test_trim_keeps_margins_and_reports_them(self):
        clip = tone(1.5, (0.30, 1.10))
        piece, head, kept_before, kept_after = trim_speech(clip)
        self.assertEqual((head, kept_before, kept_after), (7200 - 720, 720, 960))
        self.assertEqual(len(piece), 26400 + 960 - head)
        self.assertEqual((piece[0], piece[-1]), (0.0, 0.0))
        self.assertEqual(clip, tone(1.5, (0.30, 1.10)))  # the clip itself is not changed

    def test_a_short_preroll_keeps_what_there_is(self):
        _, head, kept_before, _ = trim_speech(tone(1.0, (0.01, 0.9)))
        self.assertEqual((head, kept_before), (0, 240))

    def test_silent_audio_is_left_whole(self):
        clip = [0.0] * 4800
        piece, head, kept_before, kept_after = trim_speech(clip)
        self.assertEqual((len(piece), head, kept_before, kept_after), (4800, 0, 0, 0))

    def test_noise_blip_in_preroll_is_kept_not_clipped(self):
        # Some voices (am_michael) have faint blips before the speech; trimming must stop at them, never past.
        _, head, _, _ = trim_speech(tone(1.5, (0.30, 1.10), blip=(0.10, 0.0013)))
        self.assertLessEqual(head, int(0.10 * SR))


class TimingTest(unittest.TestCase):
    def test_pause_is_measured_between_speech_edges(self):
        r = run(
            [[result(1.5, [("One", 0.25, 1.3)], **SPOKEN)], [result(1.5, [("Two", 0.25, 1.3)], **SPOKEN)]],
            [("One.", 0.55), ("Two.", 0.0)],
        )
        self.assertEqual(silences(r.stream)[1], [round(0.55 * SR)])
        self.assertEqual(r.padded, [round(0.55 * SR) - 960 - 720])
        self.assertEqual(r.samples, len(r.stream))

    def test_words_shift_by_the_cut_and_stay_inside_the_audio(self):
        tokens = [("Hello", 0.27, 0.7), ("there", 0.7, 1.35), (".", 1.35, 1.5)]  # Kokoro's last word runs past the speech
        r = run([[result(1.5, tokens, **SPOKEN)], [result(1.5, [("Bye", 0.27, 1.3)], **SPOKEN)]], [("Hello there.", 0.55), ("Bye.", 0.0)])
        piece = (26400 + 960 - 6480) / SR
        self.assertEqual(r.words[0], {"text": "Hello", "start": 0.0, "end": round(0.7 - 0.27, 4)})
        self.assertEqual(r.words[1]["end"], round(piece, 4))  # clamped to the trimmed audio, not 0.2 s into the pause
        self.assertEqual(r.words[2], {"text": ".", "start": round(piece, 4), "end": round(piece, 4)})
        second = piece + r.padded[0] / SR  # where the second result's trimmed audio starts
        self.assertEqual(r.words[3]["start"], round(second, 4))
        starts = [w["start"] for w in r.words]
        self.assertEqual(starts, sorted(starts))
        self.assertTrue(all(0 <= w["start"] <= w["end"] <= r.samples / SR for w in r.words))

    def test_block_lead_and_tail_are_edge_gaps(self):
        r = run([[result(1.5, [("Hi", 0.27, 1.3)], **SPOKEN)]], [("Hi.", 0.0)], lead=0.25, tail=0.75)
        self.assertEqual(r.padded, [round(0.25 * SR) - 720, round(0.75 * SR) - 960])
        lead, _, tail = silences(r.stream)
        self.assertEqual((lead, tail), (round(0.25 * SR), round(0.75 * SR)))
        # Kokoro starts a word ~30 ms before it is heard, inside the kept margin, so it starts where the piece does.
        self.assertEqual(r.words[0]["start"], round((round(0.25 * SR) - 720) / SR, 4))

    def test_pieces_of_one_segment_join_with_a_clause_gap(self):
        # Kokoro cuts a result over its phoneme limit in two; the halves are one sentence, so they get a clause's gap.
        r = run([[result(1.5, [("a", 0.27, 1.3)], **SPOKEN), result(1.5, [("b", 0.27, 1.3)], **SPOKEN)]], [("a b.", 0.0)])
        self.assertEqual(silences(r.stream)[1], [round(CLAUSE_GAP * SR)])

    def test_missing_tokens_still_trim_and_pause(self):
        # A Spanish voice returns tokens=None: no word timing, but the audio is trimmed and paused all the same.
        r = run([[result(1.5, None, **SPOKEN)], [result(1.5, None, **SPOKEN)]], [("Hola.", LINE_PAUSE), ("Adiós.", 0.0)])
        self.assertEqual(r.words, [])
        self.assertEqual(silences(r.stream), (720, [round(LINE_PAUSE * SR)], 960))

    def test_gaps_shrink_with_speed_and_pads_are_never_negative(self):
        spoken = [[result(1.5, [], **SPOKEN)], [result(1.5, [], **SPOKEN)]]
        self.assertEqual(silences(run(spoken, [("A.", 0.55), ("B.", 0.0)], speed=2.0).stream)[1], [round(0.275 * SR)])
        spoken = [[result(1.5, [], **SPOKEN)], [result(1.5, [], **SPOKEN)]]
        r = run(spoken, [("A.", 0.05), ("B.", 0.0)], speed=2.0)  # less than the margins already kept
        self.assertTrue(all(n >= 0 for n in r.padded))
        self.assertEqual(silences(r.stream)[1], [960 + 720])

    def test_a_segment_with_no_audio_keeps_the_longer_pause_before_it(self):
        # "***" on its own line speaks as nothing: the full stop's 0.55 s before it must not shrink to a line's 0.35 s.
        r = run([[result(1.5, [], **SPOKEN)], [], [result(1.5, [], **SPOKEN)]], [("One.", 0.55), ("***", LINE_PAUSE), ("Two.", 0.0)])
        self.assertEqual(silences(r.stream)[1], [round(0.55 * SR)])

    def test_untimed_tokens_and_silent_results_are_skipped(self):
        per_segment = [[
            result(0.4, [("ignored", 0.0, 0.1)], audio=False),  # no audio: its tokens never play
            result(1.0, [("$", None, None), ("5", 0.1, 0.6)]),  # all silence: nothing to trim, so kept whole
        ]]
        r = run(per_segment, [("$5", 0.0)])
        self.assertEqual(r.words, [{"text": "5", "start": 0.1, "end": 0.6}])
        self.assertEqual(r.written, [SR])
        self.assertEqual(r.padded, [])

    def test_no_pause_before_any_audio_and_progress_per_segment(self):
        progress = []
        pipe = FakePipeline([[result(0, audio=False)], [result(0.5, [("hi", 0.0, 0.3)])]])
        padded = []
        samples, _, words = speak_segments(
            pipe, [("", LINE_PAUSE), ("hi", 0.0)], "af_heart", 1.2,
            write=lambda a: None, pad=padded.append, on_progress=lambda d, t: progress.append((d, t)),
        )
        self.assertEqual(padded, [])  # a pause with nothing before it would shift every word
        self.assertEqual(words[0]["start"], 0.0)
        self.assertEqual(progress, [(1, 2), (2, 2)])
        self.assertEqual(pipe.calls[1], ("hi", "af_heart", 1.2, None))

    def test_counts_segments_that_hit_the_phoneme_limit(self):
        r = run([[result(0.1, phonemes="x" * 600), result(0.1, phonemes="x")]], [("t", 0.0)])
        self.assertEqual(r.truncated, 1)


@unittest.skipUnless(importlib.util.find_spec("kokoro") and cached_snapshot(), "needs Kokoro and its downloaded model")
class RealEngineTest(unittest.TestCase):
    """Speaks with the real model, so CI (bare python3) skips it. Run it with the repo's .venv."""

    def test_two_sentences_sound_natural(self):
        import tempfile
        from pathlib import Path

        import soundfile as sf

        from kokoro_engine import Engine

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "t.wav"
            r = Engine().synthesize("It rises. Does it fall? Yes.", out, fmt="WAV", lead=0.25, tail=0.75)
            x, _ = sf.read(str(out), dtype="float32")
        quiet = [i for i in range(0, len(x) - TRIM_FRAME, TRIM_FRAME) if not speech_bounds(x[i:i + TRIM_FRAME], 0.002)]
        runs, start = [], None  # silent stretches of at least 150 ms, in seconds, inside the speech
        for a, b in zip(quiet, quiet[1:] + [None]):
            start = a if start is None else start
            if b != a + TRIM_FRAME:
                if start > 0 and a + TRIM_FRAME < len(x) - TRIM_FRAME and a + TRIM_FRAME - start >= 0.15 * SR:
                    runs.append((a + TRIM_FRAME - start) / SR)
                start = None
        self.assertEqual(len(runs), 2, runs)
        self.assertAlmostEqual(runs[0], SENTENCE_PAUSES["."], delta=0.08)
        self.assertAlmostEqual(runs[1], SENTENCE_PAUSES["?"], delta=0.08)
        starts = [w["start"] for w in r["words"]]
        self.assertEqual(starts, sorted(starts))
        self.assertLessEqual(r["words"][-1]["end"], r["durationSec"])


if __name__ == "__main__":
    unittest.main()


class CpuThreadsTest(unittest.TestCase):
    def test_linux_cpu_speaks_on_half_the_cpus_up_to_the_cap(self):
        for cpus, want in ((16, 8), (8, 4), (2, 1), (1, 1), (64, MAX_CPU_THREADS)):
            self.assertEqual(cpu_threads("cpu", platform="linux", env={}, cpus=cpus), want, cpus)

    def test_macos_the_gpu_and_a_chosen_count_are_left_alone(self):
        self.assertIsNone(cpu_threads("cpu", platform="darwin", env={}, cpus=16))
        self.assertIsNone(cpu_threads("mps", platform="linux", env={}, cpus=16))
        self.assertIsNone(cpu_threads("cpu", platform="linux", env={"OMP_NUM_THREADS": "12"}, cpus=16))
