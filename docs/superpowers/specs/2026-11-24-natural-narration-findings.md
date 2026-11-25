# Natural narration: findings

What four analyses found on 2026-11-24 about why the narration sounds robotic, and what to change.
They measured the installed Kokoro 0.9.4, the 26 lessons in `video/projects/`, and how other Kokoro tools handle this.
The raw reports, scripts and samples are in the session scratchpad, under `narration/{internals,lab,contract,research}/`.

## The problem, measured

- Every Kokoro call carries silence it makes itself: **0.315 s before the speech and 0.472 s after it** (af_heart, speed 1, median of 40 real sentences).
  - The model predicts this: the BOS duration at the start, and a stretched last phoneme, the final punctuation and EOS at the end. No parameter turns it off.
  - It scales with 1/speed and differs by voice: am_michael loses 0.98 s per call.
- We call Kokoro once per sentence and then add 0.25 s, so **sentences sit 1.04 s apart** and blocks 1.28 s apart.
  - Every gap is the same length.
  - A block boundary is barely longer than a sentence boundary, so the structure is inaudible.
  - The library runs at 154 wpm overall.
- The earlier "0 ms gaps" figure was wrong. Within one call, Kokoro's token timestamps run from each word straight into the next, so the silence is counted inside the last word and the full stop.
  - A sentence-final word's `end_ts` runs **0.21 s past the audible end**, so captions and highlights end late.
  - Word starts are 20–35 ms early.
- The comment at `kokoro_engine.py:61` is wrong. Kokoro does pause when it is given several sentences in one call: 0.52 s after ".", 0.37 s after "?", 0.21 s at commas and 0.30 s at colons.

## What to change

| Change | Evidence |
|---|---|
| Trim each Kokoro result by energy. Detect at RMS 0.0005 in 5 ms frames, keep 30 ms before and 40 ms after the speech, and apply 5 ms fades. | Across 200 clips this clipped nothing above −62 dBFS. The common 0.002 threshold clips aspiration at about −55 dBFS. Fixed BOS/EOS trims clip word onsets (hexgrad/kokoro#228). |
| Size each pause as the gap **from the end of one stretch of speech to the start of the next**, not as silence appended to Kokoro's own. | This is what kokoro-onnx (`pauses.py`) and Kokoro-FastAPI do. |
| Vary the pause by boundary type (sentence, question, colon, line, paragraph, block). | Read speech averages 0.60 s at `. ? !` and 0.34 s at `, : ;` (Campione & Véronis 2002). Listeners notice pause length mainly when it violates expectation (Google rater study). |
| Shift and clamp word times after trimming. | Otherwise animation marks drift and captions overlap. |
| Bump `CACHE_VERSION` in `video/narrate.py:23` from 2 to 3. Add an audio version to the Audio tab's duplicate check and preview file names. | Nothing else hashes engine output (contract report §1). |
| Recalibrate `WORDS_PER_MINUTE` (150 today) from measured re-narrations. | Variant C is 12% faster than today: 138 → 158 wpm on the samples, about 172 wpm on the library. Leaving 150 makes a "5 minute" lesson run about 4.3 minutes. |

Sending 2–3 sentences per call (variant D) is **optional**.
- It took 0.79× the synthesis time and is 3% slower to listen to.
- The lab found no systematic change in intonation.
- It switches Kokoro's voice-style row by phoneme count.
- It needs splicing inside a call, the hardest code here.
- Decide by listening.

Existing scenes survive shorter narration.
- Waits never go negative, and overruns are warnings, never errors.
- The estimate is about 7 animation gaps newly late by more than 0.3 s across the library, and none by more than 0.5 s.

## A/B samples

Four real blocks are rendered five ways, in `/private/tmp/claude-501/-Users-anandkumarnuranisubramanian-Dev-tts-dir/2627f693-577d-43c0-bc1b-c62249171c74/scratchpad/narration/lab/samples/`:

| File | What | Length (123 words) | wpm | Sentence gap | Block gap |
|---|---|---|---|---|---|
| `ALL-A.wav` | Today | 53.3 s | 138 | 1.03–1.09 s | 1.27 s |
| `ALL-B.wav` | Trimmed, today's pause table | 45.1 s | 164 | 0.35 s | 0.59 s |
| `ALL-C.wav` | Trimmed, new pause table | 46.8 s | 158 | 0.45 s (? 0.55) | 0.80 s |
| `ALL-D.wav` | C, with 2–3 sentences per call | 48.4 s | 152 | 0.45 s (? 0.55) | 0.80 s |
| `ALL-E.wav` | C with the research's longer gaps | 48.4 s | 152 | 0.55 s (? 0.65) | 1.00 s |
