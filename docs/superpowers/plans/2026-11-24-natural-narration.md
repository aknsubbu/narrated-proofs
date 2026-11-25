# Natural Narration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Narration with natural, varied pauses: Kokoro's own silence is trimmed and replaced by speech-edge-to-speech-edge gaps chosen by boundary type, with word times kept exact.

**Architecture:** Every change to the audio happens in `speak_segments` (`tts-studio/engine/kokoro_engine.py`). It is the one place that holds the audio, the tokens and the running sample count together.
- Each Kokoro result is trimmed by energy, with pure-Python helpers so the engine tests stay standard-library-only.
- Pauses become gaps between stretches of speech, sized after subtracting the margins the trim kept.
- Word times are shifted by the head cut and clamped to the trimmed audio.
- Cached narration is invalidated by version bumps, and the writer's words-per-minute figure is then recalibrated from measured re-narrations.

**Tech Stack:** Python 3.12 (Kokoro 0.9.4, numpy and soundfile, used only at runtime), Node 20 (Express, node:test), React and vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-natural-narration-findings.md`

## Global Constraints

- `tts-studio/engine/test_engine.py` must keep needing **only the standard library**. CI runs `npm run test:python` with a bare `python3`, which has no numpy. New helpers in `kokoro_engine.py` therefore work on any sequence of floats, and numpy is imported only inside `synthesize`, as it is today.
- Trim constants: `TRIM_THRESHOLD = 0.0005` (frame RMS), `TRIM_FRAME = 120` samples (5 ms at 24 kHz), `KEEP_BEFORE = 0.030` s, `KEEP_AFTER = 0.040` s, `FADE = 0.005` s.
- Pause values: **variant E, chosen by the person after listening (2026-11-24).** They are speech-edge to speech-edge, at speed 1, divided by `max(speed, 0.5)` as today:
  - `SENTENCE_PAUSES = {".": 0.55, "!": 0.55, "?": 0.65, "…": 0.65, ":": 0.45, "。": 0.55, "！": 0.55, "？": 0.65}`
  - `LINE_PAUSE = 0.35`, `PARAGRAPH_PAUSE = 0.90`, `CLAUSE_GAP = 0.25` (between pieces of one over-long sentence)
  - `BLOCK_LEAD = 0.25`, `BLOCK_TAIL = 0.75` (1.0 s between blocks)
- Keep the voiceover wording "ran X s past". `onlySmallOverruns` in `tts-studio/author/pipeline.js:254` matches it.
- Do not change `CACHE_VERSION` in `video/build.py`, or anything in `versions.js`, `edits.js` or `shared/limits.js` lesson lengths.
- Comments follow the codebase voice: plain English that explains why.
- Work on branch `narration-natural-pauses`, created **after** the Tier 1 and Tier 4 worktrees are merged into master. Task 6 edits `guide.md`, `author.test.js` and `chapters.test.js`, which those worktrees also change.

## Review Focus

1. **A result with no frame above the threshold** (silence, or a whisper-quiet piece) is left untrimmed. There is no crash and no negative time. Test in Task 2.
2. **An over-long sentence cut by `_hard_split`, or a result Kokoro chunked at 510 phonemes,** joins its pieces with `CLAUSE_GAP`, not with about 70 ms of kept margins. Test in Tasks 2 and 3.
3. **A non-English voice** (`tokens=None`) is still trimmed and paused, and returns no words. Test in Task 2.
4. **High speed** (2.0): no pad is ever negative, and gaps shrink with speed. Test in Task 2.
5. **A voice with noise blips in its pre-roll** (am_michael: about −58 dBFS blips, above the threshold) is under-trimmed, never clipped: the bound lands at or before the blip. Test in Task 2.

---

### Task 1: Baseline on copies of real lessons

Nothing is changed in the repo. This records today's numbers so Task 5 can compare them.

**Files:**
- Create (temporary, deleted in Task 5): `video/projects/zz-narr-hessian/`, `video/projects/zz-narr-poker/`, `video/projects/zz-narr-adagrad/`

**Interfaces:**
- Produces: `docs/superpowers/specs/narration-baseline.json`, holding `{project: {words, seconds, wpm, overrun_warnings: [..]}}`

- [ ] **Step 1:** For each source (`ls -d video/projects/hessian-condition* video/projects/poker-fundamentals* video/projects/regret-adagrad*`), copy only `script.txt`, `scenes.py` and `project.json` into a new `video/projects/zz-narr-<short>/`. Copies are used because `check.py` re-narrates in place and would overwrite a real lesson's manifest.
- [ ] **Step 2:** Run `.venv/bin/python video/check.py zz-narr-<short>` for each copy. Expected: the check passes, as the real lesson did.
- [ ] **Step 3:** From each copy's `build/manifest.json` (block `duration`, word count of the block text) and `build/check/report.json` (`warnings` whose message matches `ran (\d+(\.\d+)?)s past`), write `narration-baseline.json`. Expected wpm is about 138–155.

### Task 2: Trim helpers and the new `speak_segments`

**Files:**
- Modify: `tts-studio/engine/kokoro_engine.py:61-69` (constants and the comment, which wrongly says Kokoro leaves no gap in one call)
- Modify: `tts-studio/engine/kokoro_engine.py:253-287` (`speak_segments`)
- Test: `tts-studio/engine/test_engine.py` (rewrite `TimingTest` at :133-195; extend the `result()` fake at :103)

**Interfaces:**
- Produces:
  - `speech_bounds(audio, threshold=TRIM_THRESHOLD, frame=TRIM_FRAME) -> tuple[int, int] | None`: the sample index where the first frame with RMS ≥ threshold starts, and where the last such frame ends. It scans inward from each end, so the cost scales with the silence, not the clip. It returns `None` when no frame qualifies.
  - `trim_speech(audio) -> tuple[piece, head, kept_before, kept_after]`:
    - `piece` is a faded copy of `audio[head:end]`;
    - `head` is the samples cut from the front;
    - `kept_before` and `kept_after` are the silent samples left on each side, each at most the `KEEP_*` margin.
    - With no bounds it returns the audio unchanged, with `head=0` and both margins 0.
    - Works on lists and numpy arrays.
  - `speak_segments(pipeline, segments, voice, speed, write, pad, on_progress=None, lead=0.0, tail=0.0) -> (samples, truncated, words)`. The signature gains `lead` and `tail`, and `pause` values become edge-to-edge gaps.

- [ ] **Step 1: Make the fakes speak.** Extend `result(seconds, tokens=(), phonemes="", audio=True, speech=None)`. With `speech=(a, b)` in seconds, the samples are 0.0 outside `[a, b)` and 0.1 inside. With `speech=None`, keep today's all-zero audio, which now means "untrimmable".
- [ ] **Step 2: Write the failing tests** in `TimingTest`:
  - `test_speech_bounds_find_the_first_and_last_loud_frame`: speech at 0.30–1.10 s gives bounds within one frame (120 samples) of 7200 and 26400. All zeros give `None`.
  - `test_trim_keeps_margins_and_reports_them`: from the same clip, `head == 7200 - 720`, `kept_before == 720`, `kept_after == 960`, and the first and last samples of `piece` are 0.0 (the fade).
  - `test_pause_is_measured_between_speech_edges`: two sentences, gap 0.55, speed 1. The padded silence equals `round(0.55*SR) - 960 - 720`, so the silence between the two loud regions in the written stream is 0.55 s ± one frame.
  - `test_words_shift_by_the_cut_and_stay_inside_the_audio`: the first word's start becomes `start_ts - head/SR` (≥ 0). A last word whose `end_ts` lies past the trimmed end is clamped to it. All starts are non-decreasing, and the last `end` is ≤ `samples/SR`.
  - `test_block_lead_and_tail_are_edge_gaps`: `lead=0.25, tail=0.75` give a first pad of `round(0.25*SR) - kept_before` and a last pad of `round(0.75*SR) - kept_after`.
  - `test_pieces_of_one_segment_join_with_a_clause_gap`: two results queued for one segment are joined by `CLAUSE_GAP` edge to edge.
  - Review Focus 1, `test_silent_result_is_left_whole`: no crash, and its words are ≥ 0.
  - Review Focus 3, `test_missing_tokens_still_trim_and_pause`: rewrite of :176.
  - Review Focus 4, `test_pads_never_negative_at_high_speed`: speed 2.0 with margins larger than the shrunken gap gives every pad ≥ 0.
  - Review Focus 5, `test_noise_blip_in_preroll_is_kept_not_clipped`: a 5 ms blip at 0.1 s at amplitude 0.0013, with speech from 0.3 s, gives `head ≤ 0.1*SR`.
  - Keep `test_counts_segments_that_hit_the_phoneme_limit`. Keep "progress per segment" and "no pause before any audio when `lead=0`".
- [ ] **Step 3:** Run `cd tts-studio && python3 -m unittest discover -s engine -v`. Expected: the new tests FAIL (NameError on `speech_bounds`, wrong pads).
- [ ] **Step 4: Implement** the helpers and the new `speak_segments` in `kokoro_engine.py`. For each result:
  1. convert the audio;
  2. `trim_speech`;
  3. pad `max(0, round(gap/max(speed,0.5)*SR) - prev_kept_after - kept_before)`, where `gap` is `lead` before the first piece, the previous segment's pause between segments, and `CLAUSE_GAP` between results of one segment;
  4. add the words, with `start`/`end` = `offset + clamp(ts - head/SR, 0, len(piece)/SR)`, rounded to 4 dp;
  5. write the piece and advance `samples` by `len(piece)`.

  After the loop, pad `max(0, round(tail/max(speed,0.5)*SR) - last_kept_after)` if anything was written. Update the constants comment at :61.
- [ ] **Step 5:** Run the same command. Expected: all PASS.
- [ ] **Step 6:** Commit: `feat(engine): trim Kokoro's silence and pause between speech edges`.

### Task 3: Pause table, block edges, cache bump

**Files:**
- Modify: `tts-studio/engine/kokoro_engine.py:66-69` (values per Global Constraints; add `":"`, `CLAUSE_GAP`, `BLOCK_LEAD`)
- Modify: `tts-studio/engine/kokoro_engine.py:168-186` (`split_segments`: `_hard_split` pieces get `CLAUSE_GAP` instead of `0.0`)
- Modify: `tts-studio/engine/kokoro_engine.py:349-391` (`synthesize(..., lead=0.0, tail=0.0)` passes both to `speak_segments` and stops writing its own tail)
- Modify: `video/narrate.py:23` (`CACHE_VERSION = 3`) and `video/narrate.py:222-229` (import `BLOCK_LEAD`, pass `lead=BLOCK_LEAD, tail=BLOCK_TAIL`)
- Modify: `tts-studio/README.md:36` (pause wording)
- Test: `tts-studio/engine/test_engine.py` (`SplitTest` at :34-65), plus a new `RealEngineTest`

**Interfaces:**
- Consumes: `speak_segments(..., lead, tail)` from Task 2.
- Produces: `Engine.synthesize(text, out, voice, speed, fmt=None, on_progress=None, lead=0.0, tail=0.0)`; the constants `BLOCK_LEAD` and `CLAUSE_GAP`.

- [ ] **Step 1:** Update the `SplitTest` expectations:
  - pauses read from the table by ending, with `":"` → 0.45 at a line end;
  - `test_respects_the_limit…` asserts that hard-split pieces carry `CLAUSE_GAP`;
  - `PARAGRAPH_PAUSE > max(SENTENCE_PAUSES.values())` still holds.
- [ ] **Step 2:** Add `RealEngineTest.test_two_sentences_sound_natural`. It is skipped unless `importlib.util.find_spec("kokoro")` is present and `cached_snapshot()` is not None, so CI skips it.
  - Synthesize "It rises. Does it fall? Yes." to a temp WAV with `lead=0.25, tail=0.75`.
  - Read it with soundfile, and find silent runs ≥ 150 ms with `speech_bounds`-style framing at 0.002.
  - Assert the two internal gaps are 0.55 ± 0.08 and 0.65 ± 0.08, the words never decrease, and the last end ≤ `durationSec`.
- [ ] **Step 3:** Run `cd tts-studio && ../.venv/bin/python -m unittest discover -s engine -v` (the repo-root venv has Kokoro and the model). Expected: the Split tests FAIL before the change.
- [ ] **Step 4:** Implement the changes listed under Files.
- [ ] **Step 5:** Run the Step 3 command, then `python3 -m unittest discover -s engine` (bare). Expected: both PASS, and RealEngineTest is skipped under bare python3.
- [ ] **Step 6:** Run `cd video && ../.venv/bin/python -m unittest -q`. Expected: PASS. `test_narrate` uses `block_key()` itself, so the bump does not break it.
- [ ] **Step 7:** Commit: `feat(narration): pause by boundary type; re-narrate cached blocks (CACHE_VERSION 3)`.

### Task 4: Audio tab sees the new engine

`MODEL_ID` (`server/kokoro.js:6`) names the model on every row, and the model has not changed, so leave it as it is. Instead, version the audio.

**Files:**
- Modify: `tts-studio/server/kokoro.js:6` (add `export const AUDIO_VERSION = 2;`, with a comment saying to bump it together with `CACHE_VERSION` in `video/narrate.py`)
- Modify: `tts-studio/server/app.js:225` (the config hash includes `AUDIO_VERSION`)
- Modify: `tts-studio/server/db.js:212` (`previewPath(voiceId, version)` gives `<voiceId>.v<version>.mp3`) and its call in `app.js` (voice preview route)
- Test: `tts-studio/server/test/app.test.js`

**Interfaces:**
- Produces: `AUDIO_VERSION` (number), exported from `server/kokoro.js`.

- [ ] **Step 1:** Write failing tests:
  - `a preview file is named for the audio version`: the preview route writes `previews/<voice>.v2.mp3` (use the fake engine).
  - `audio made before a new engine is not offered as a duplicate`: insert a done row whose `config_hash` is the old formula, POST the same text, and expect `duplicate: false`.
- [ ] **Step 2:** Run `cd tts-studio && node --test server/test/app.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run test:server && npm run lint`. Expected: PASS. `app.test.js:141` still sees `modelId === 'kokoro-82m'`.
- [ ] **Step 5:** Commit: `feat(audio): re-speak audio and previews made by the old engine`.

### Task 5: Measure on the copies, and listen

**Files:**
- Read: `docs/superpowers/specs/narration-baseline.json`
- Create: `docs/superpowers/specs/narration-after.json`, same shape
- Delete: `video/projects/zz-narr-*`

- [ ] **Step 1:** Run `.venv/bin/python video/check.py zz-narr-<short>` again on each copy. It now re-narrates because of `CACHE_VERSION 3`. Expected: it passes.
- [ ] **Step 2:** Write `narration-after.json`. Pass condition:
  - wpm is 10–16% above baseline;
  - in each `manifest.json`, word starts never decrease and every block's last word `end` ≤ its `duration`;
  - at most 3 new "ran X s past" warnings per copy, none over 0.5 s.

  If the warnings are worse, stop and report before Task 6.
- [ ] **Step 3:** Concatenate one block from each copy (`build/audio/*.wav`) into a temporary directory, and play it next to the same blocks from the real lessons with `open`. Note anything clipped or odd.
- [ ] **Step 4:** `rm -rf video/projects/zz-narr-*`, then check that `git status` shows no stray project folders.

### Task 6: Recalibrate words per minute

**Files:**
- Modify: `tts-studio/shared/limits.js` (add `export const WORDS_PER_MINUTE = <measured>`)
- Modify: `tts-studio/author/prompts.js:6` (import it instead of defining 150)
- Modify: `tts-studio/client/src/utils.js:43` (`estimateSeconds` uses the shared constant)
- Modify: `tts-studio/author/prompts/guide.md:41,54,113,206`
- Test: `tts-studio/author/test/author.test.js:73,223,232,354`, `tts-studio/author/test/chapters.test.js:125-128`, `tts-studio/client/src/utils.test.js`

**Interfaces:**
- Consumes: the mean wpm from `narration-after.json` (Task 5).
- Produces: `WORDS_PER_MINUTE` in `shared/limits.js`, the one place this number lives.

- [ ] **Step 1:** Set `<measured>` to the Task 5 mean wpm, rounded to the nearest 5 (expected 165–175). Scale every pinned test number by `<measured>/150`, rounding as each test already does: the 130–170 range, "about 150", `words(150)`, 640–830, "about 600" and "900".
- [ ] **Step 2:** Run `npm run test:server && npx vitest run`. Expected: FAIL on the old numbers.
- [ ] **Step 3:** Implement the constant and the imports. In `guide.md`:
  - :41 becomes "about <measured> words a minute";
  - :54 keeps "15 to 45 words", with seconds recomputed as 45/<measured>×60, rounded;
  - :113 keeps "about three words a second" if it stays within 2.6–3.1 (expected 2.8);
  - :206: recompute the worked example's length as its word count divided by <measured>.
- [ ] **Step 4:** Run `npm run test:server && npx vitest run && npm run lint`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(writer): budget words at the new narration pace`.

### Task 7 (only if the person chooses variant D): two or three sentences per call

**Files:**
- Modify: `tts-studio/engine/kokoro_engine.py` (`split_segments` gains `group=False`; `speak_segments` splices the gaps inside each result)
- Test: `tts-studio/engine/test_engine.py`

**Interfaces:**
- Consumes: `trim_speech` and `speech_bounds` from Task 2.
- Produces:
  - `split_segments(text, limit, group=False)`. With `group=True`, consecutive sentences of one line are joined into segments of at most 3 sentences and at most `limit` characters. Each segment carries `inner=[pause, …]` for its internal boundaries.
  - `synthesize(..., group=False)`. narrate.py passes `group=True` for English voices only (`voice[0] in "ab"`).

- [ ] **Step 1: Write the failing tests.**
  - Grouping respects 3 sentences and the limit, and never groups across a line or paragraph.
  - A fake result with two loud regions and a 0.52 s quiet run, with gap 0.55, comes out 0.55 edge to edge (and one with a 0.70 s run shrinks to 0.55). Gaps must be able to *shrink* a run as well as lengthen it.
  - Words after the splice shift by exactly the change in silence, which can be negative.
  - A boundary whose quiet run is under 80 ms keeps its audio unchanged.
- [ ] **Step 2:** Run the engine tests. Expected: FAIL.
- [ ] **Step 3: Implement the splice.** For each internal sentence end, the token matching the sentence's final punctuation gives a window of ±0.3 s.
  - Inside that window, find the longest run of 5 ms frames with RMS < 0.001.
  - Keep `min(0.040 s, 40% of the run)` on each side, and replace the middle with exact zeros sized so the edge-to-edge gap equals the pause divided by `max(speed, 0.5)`.
  - Shift every later token by the change.
- [ ] **Step 4:** Run the engine tests, then the RealEngineTest with grouping on. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(engine): speak two or three sentences per call`.

---

## Hand-off: the decisions that are the person's

Listen to `ALL-A.wav` (today), then C, D and E, from `/private/tmp/claude-501/-Users-anandkumarnuranisubramanian-Dev-tts-dir/2627f693-577d-43c0-bc1b-c62249171c74/scratchpad/narration/lab/samples/`. Listen for:
- the question gap in the first block;
- the gaps between blocks;
- whether D's flow is worth its extra code.

The answers decide the pause table (C or E) and whether Task 7 runs. Tasks 1–6 need only the table.
