import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, normalizeWord, wordsMatch, ScriptMatcher } from '../js/matcher.js';

const SCRIPT = `Welcome to Teleprompt Pro, your voice-powered teleprompter.

Just start reading this script out loud, and watch the text scroll along with you. There is no need to set a speed or touch anything while you present.

If you skip a sentence, improvise for a moment, or stumble over a few words, don't worry. The prompter waits for you, and the moment you return to the script, it picks up right where you are and keeps going.

You can adjust the font size, colors, and margins from the settings panel, switch to a classic auto-scroll mode, or nudge the position with the arrow keys at any time.`;

function makeMatcher(text = SCRIPT) {
  const { tokens } = parseScript(text);
  return { matcher: new ScriptMatcher(tokens), tokens };
}

// Simulate the speech engine: feed a growing transcript word-by-word, the way
// interim results arrive, and return the matcher's final position.
function speak(matcher, words, chunk = 3) {
  let result = { position: matcher.position, moved: false };
  for (let i = chunk; i <= words.length + chunk - 1; i += chunk) {
    result = matcher.feed(words.slice(0, i));
  }
  return matcher.position;
}

test('normalizeWord strips punctuation and lowercases', () => {
  assert.equal(normalizeWord('Hello,'), 'hello');
  assert.equal(normalizeWord('"Don’t"'), "don't");
  assert.equal(normalizeWord('twenty'), '20');
  assert.equal(normalizeWord('—'), '');
});

test('parseScript keeps paragraph structure and flat tokens aligned', () => {
  const { paragraphs, tokens } = parseScript('Hello world.\n\nSecond — line.');
  assert.equal(paragraphs.length, 3);
  assert.equal(paragraphs[1].length, 0);
  assert.deepEqual(tokens, ['hello', 'world', 'second', 'line']);
  // the dash renders but is not matchable
  const dash = paragraphs[2].find((w) => w.raw === '—');
  assert.equal(dash.index, -1);
});

test('wordsMatch tolerates small recognition errors and stems', () => {
  assert.ok(wordsMatch('teleprompter', 'teleprompted'));
  assert.ok(wordsMatch('record', 'recording'));
  assert.ok(wordsMatch('color', 'colour'));
  assert.ok(!wordsMatch('cat', 'car')); // short words must be exact
  assert.ok(!wordsMatch('hello', 'world'));
});

test('follows a perfect reading to the end', () => {
  const { matcher, tokens } = makeMatcher();
  const pos = speak(matcher, tokens);
  assert.equal(pos, tokens.length - 1);
});

test('re-feeding the same transcript does not advance the position', () => {
  const { matcher, tokens } = makeMatcher();
  matcher.feed(tokens.slice(0, 8));
  const p1 = matcher.position;
  matcher.feed(tokens.slice(0, 8));
  matcher.feed(tokens.slice(0, 8));
  assert.equal(matcher.position, p1);
});

test('survives misrecognized words', () => {
  const { matcher, tokens } = makeMatcher();
  const noisy = tokens.slice(0, 30).map((w, i) => (i % 5 === 2 ? 'banana' : w));
  const pos = speak(matcher, noisy);
  assert.ok(pos >= 25, `expected >= 25, got ${pos}`);
});

test('reader skips half a sentence and the matcher catches up', () => {
  const { matcher, tokens } = makeMatcher();
  // Read 10 words, skip 12, continue reading.
  const spoken = [...tokens.slice(0, 10), ...tokens.slice(22, 40)];
  const pos = speak(matcher, spoken);
  assert.ok(pos >= 38, `expected >= 38, got ${pos}`);
});

test('ad-libbing does not move the position, then resumes correctly', () => {
  const { matcher, tokens } = makeMatcher();
  speak(matcher, tokens.slice(0, 12));
  const anchored = matcher.position;
  // Off-script rambling: position must hold.
  const adlib = 'so anyway like I was telling my friend yesterday about the weather'.split(' ');
  matcher.feed([...tokens.slice(0, 12), ...adlib]);
  assert.ok(Math.abs(matcher.position - anchored) <= 2,
    `position drifted from ${anchored} to ${matcher.position} during ad-lib`);
  // Return to the script.
  const back = [...tokens.slice(0, 12), ...adlib, ...tokens.slice(12, 24)];
  speak(matcher, back);
  assert.ok(matcher.position >= 21, `expected resume >= 21, got ${matcher.position}`);
});

test('big jump ahead is found via widened search after misses', () => {
  const { matcher, tokens } = makeMatcher();
  speak(matcher, tokens.slice(0, 8));
  // Jump way past the lookahead window (60): continue from word 90.
  const jumped = tokens.slice(90, 110);
  let pos = matcher.position;
  for (let i = 4; i <= jumped.length; i += 4) {
    pos = matcher.feed(jumped.slice(0, i)).position;
  }
  assert.ok(pos >= 105, `expected to reacquire >= 105, got ${pos}`);
});

test('repeated phrases resolve near the current position', () => {
  const text = 'thank you very much everyone. ' +
    'we are gathered here today for something special. ' +
    'thank you very much everyone. ' +
    'and now the show begins.';
  const { matcher, tokens } = makeMatcher(text);
  // Read just the first phrase; should anchor at the FIRST occurrence.
  speak(matcher, tokens.slice(0, 5));
  assert.ok(matcher.position <= 6, `anchored too far: ${matcher.position}`);
});

test('short re-read (going back a line) is honored', () => {
  const { matcher, tokens } = makeMatcher();
  speak(matcher, tokens.slice(0, 20));
  assert.ok(matcher.position >= 18);
  // Re-read words 12-19 (fresh utterance after a recognition restart).
  matcher.feed(tokens.slice(12, 17));
  const p = matcher.position;
  assert.ok(p >= 14 && p <= 19, `expected re-read position 14-19, got ${p}`);
});

test('gibberish never moves the position', () => {
  const { matcher } = makeMatcher();
  const before = matcher.position;
  for (let i = 0; i < 8; i++) {
    matcher.feed(['flurble', 'wuzzle', 'quibble', 'zonk', 'mxyzptlk']);
  }
  assert.equal(matcher.position, before);
});

test('empty and punctuation-only input is harmless', () => {
  const { matcher } = makeMatcher();
  assert.equal(matcher.feed([]).moved, false);
  assert.equal(matcher.feed(['—', '...']).moved, false);
  const { matcher: empty } = makeMatcher('');
  assert.equal(empty.feed(['hello']).moved, false);
});

test('single strong word advances from the very start', () => {
  const { matcher } = makeMatcher();
  const res = matcher.feed(['welcome']);
  assert.ok(res.position <= 2, `single word jumped too far: ${res.position}`);
});

test('backward jump to an earlier paragraph is reacquired (regression)', () => {
  const { matcher, tokens } = makeMatcher();
  speak(matcher, tokens); // read to the end
  assert.ok(matcher.position >= tokens.length - 2);
  // Jump back ~85 tokens and re-read; fresh utterance, growing transcript.
  const reread = tokens.slice(20, 48);
  let pos = matcher.position;
  for (let i = 4; i <= reread.length; i += 4) {
    pos = matcher.feed(reread.slice(0, i)).position;
  }
  assert.ok(pos >= 40 && pos <= 50, `expected reacquire near 44-47, got ${pos}`);
});

test('repetitive text does not run away from the reader (regression)', () => {
  const text = Array(40).fill('buffalo').join(' ');
  const { matcher } = makeMatcher(text);
  const words = [];
  for (let i = 0; i < 15; i++) {
    words.push('buffalo');
    matcher.feed(words);
  }
  assert.ok(matcher.position <= 16,
    `position ${matcher.position} overshot after 15 spoken words`);
});

test('1-2 word fragments cannot teleport the position while lost (regression)', () => {
  const { matcher, tokens } = makeMatcher();
  speak(matcher, tokens.slice(0, 12));
  const anchored = matcher.position;
  for (let i = 0; i < 5; i++) {
    matcher.feed(['flurble', 'wuzzle', 'quibble', 'zonk', 'grimble']);
  }
  matcher.feed(['and']);
  matcher.feed(['and', 'the']);
  assert.equal(matcher.position, anchored,
    'short function-word fragment moved the position during widened search');
});

test('riffing with common script words does not drag the position (regression)', () => {
  const { matcher, tokens } = makeMatcher();
  speak(matcher, tokens.slice(0, 12));
  const anchored = matcher.position;
  // Off-script riff arriving as short fresh-utterance fragments, full of
  // common words that also appear in the script — but no verbatim phrases.
  // These must not drag the prompter forward.
  const riff = ['so', 'anyway', 'what', 'i', 'was', 'thinking', 'about', 'this', 'whole',
    'process', 'like', 'when', 'we', 'did', 'that', 'shoot', 'last', 'week', 'you',
    'know', 'the', 'one', 'with', 'the', 'lights', 'or', 'whatever'];
  for (let i = 0; i < riff.length; i += 2) {
    matcher.feed(riff.slice(i, i + 2));
    matcher.feed(riff.slice(Math.max(0, i - 6), i + 2));
  }
  assert.ok(Math.abs(matcher.position - anchored) <= 8,
    `riff dragged position from ${anchored} to ${matcher.position}`);
  // Returning to the script re-locks within a phrase.
  let pos = matcher.position;
  const resume = tokens.slice(12, 24);
  for (let i = 3; i <= resume.length; i += 3) {
    pos = matcher.feed(resume.slice(0, i)).position;
  }
  assert.ok(pos >= 20, `expected re-lock >= 20 after riff, got ${pos}`);
});

test('feed reports lost state after repeated misses', () => {
  const { matcher, tokens } = makeMatcher();
  speak(matcher, tokens.slice(0, 12));
  let res;
  for (let i = 0; i < 4; i++) {
    res = matcher.feed(['flurble', 'wuzzle', 'quibble', 'zonk']);
  }
  assert.equal(res.lost, true);
  const back = matcher.feed(tokens.slice(12, 20));
  assert.equal(back.lost, false);
  assert.ok(back.moved);
});
