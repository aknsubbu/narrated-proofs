import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeOutline, OUTLINE_COLORS } from '../pipeline.js';

const PROMPTS = fileURLToPath(new URL('../prompts', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const NOTATION = (...colors) => colors.map((color, i) => ({ tex: `x_${i}`, meaning: 'm', color }));
const colorsOf = (...colors) => normalizeOutline({ title: 't', notation: NOTATION(...colors), chapters: [{ title: 'One' }] }).notation.map((n) => n.color);

/** The colour constants of the installed manimlib, or null when it is not installed here. */
function manimColors() {
  const manimgl = process.env.MANIMGL || path.join(REPO, '.venv', 'bin', 'manimgl');
  const python = path.join(path.dirname(manimgl), 'python');
  if (!fs.existsSync(python)) return null;
  const code = 'import json, manimlib.constants as c; print(json.dumps([n for n in dir(c) if n.isupper() and str(getattr(c, n)).startswith("#")]))';
  try {
    return new Set(JSON.parse(execFileSync(python, ['-c', code], { encoding: 'utf8', timeout: 60_000 }).trim().split('\n').pop()));
  } catch {
    return null;
  }
}

test('an outline colour that ManimGL lacks is replaced, one it has is kept', () => {
  assert.deepEqual(colorsOf('PINK', 'ORANGE', 'BLUE_B', 'GOLD_E', 'GREY', 'WHITE'), ['PINK', 'ORANGE', 'BLUE_B', 'GOLD_E', 'GREY', 'WHITE']);
  assert.deepEqual(colorsOf('PINK_B', 'ORANGE_C', 'BLUE_F', 'GRAY', 'LIGHT_BLUE'), ['BLUE', 'GREEN', 'YELLOW', 'RED', 'ORANGE'], 'each gets one from the palette instead');
});

test('every colour the outline accepts, and every shade the prompts name, is a constant in the installed manimlib', (t) => {
  const real = manimColors();
  if (!real) return t.skip('manimlib is not installed (set MANIMGL, or run install.sh)');
  assert.deepEqual(OUTLINE_COLORS.filter((c) => !real.has(c)), [], 'accepted by the outline but not in manimlib/constants.py');
  // The other way round: a shaded colour manimlib has, but the outline would refuse, is only a missed chance.
  assert.ok(!OUTLINE_COLORS.includes('PINK_B') && !real.has('PINK_B') && !real.has('ORANGE_B'), 'PINK and ORANGE have no shades');
  const named = new Set();
  for (const file of fs.readdirSync(PROMPTS).filter((f) => f.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(PROMPTS, file), 'utf8');
    for (const m of text.matchAll(/\b(?:BLUE|GREEN|YELLOW|RED|ORANGE|PURPLE|TEAL|PINK|GREY|GOLD|MAROON|WHITE|BLACK|LIGHT_PINK)(?:_[A-E])?\b/g)) named.add(`${m[0]} (${file})`);
  }
  assert.ok(named.size > 10, 'the prompts name colours');
  assert.deepEqual([...named].filter((n) => !real.has(n.split(' ')[0])), [], 'named in a prompt but not in manimlib/constants.py');
});
