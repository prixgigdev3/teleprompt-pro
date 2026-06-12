import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSession, buildCoachPrompt } from '../js/analysis.js';

const SCRIPT = `Welcome everyone to this special presentation about our product.

Today I will walk you through the three main features that make this product unique in the market today.

First we have the dashboard which gives you a complete overview of everything happening in your business.

Second is the reporting engine that turns your raw numbers into clear actionable insights every single week.

And finally the automation layer which quietly handles all the repetitive work behind the scenes.`;

// Build a plausible session: reads steadily, pauses once, fumbles once,
// says "basically" a lot, and skips a chunk near the end.
function makeSession() {
  const heard = [];
  const activity = [];
  const trace = [];
  const marks = [];
  let t = 0;
  let pos = -1;

  const say = (words, gapMs = 400, advance = true) => {
    t += gapMs;
    activity.push(t);
    heard.push({ t, w: words });
    if (advance) {
      pos += words.split(/\s+/).length;
      trace.push({ t, pos });
    }
  };

  say('welcome everyone to this special');
  say('presentation about our product');
  say('basically today i will walk you', 600, false);
  trace.push({ t, pos: (pos += 5) });
  say('through the three main features');
  say('basically that make this product');
  say('unique in the market today');

  // long pause (thinking)
  t += 6000;
  activity.push(t);

  say('first we have the dashboard');
  say('basically which gives you a complete');
  say('overview of everything happening');

  // fumble: goes back and re-reads
  trace.push({ t: t + 500, pos: pos - 6 });
  marks.push({ t: t + 500, type: 'retake', from: pos, to: pos - 6 });
  t += 500;
  say('which gives you a complete overview', 800, false);
  trace.push({ t, pos });

  say('of everything happening in your business');
  say('basically second is the reporting engine');

  // skip a big chunk: jump from ~mid to near the end
  trace.push({ t: t + 1000, pos: pos + 20 });
  pos += 20;
  t += 1000;
  say('and finally the automation layer');
  say('which quietly handles all the repetitive work');

  return {
    id: 'r_test', scriptId: 's_test', scriptTitle: 'Test', scriptText: SCRIPT,
    startedAt: 0, elapsedSec: Math.round(t / 1000) + 100, // pad past 90s gate? keep real
    tokensTotal: 0, finalPos: pos,
    words: heard.reduce((n, h) => n + h.w.split(/\s+/).length, 0),
    heard, activity, trace, marks,
  };
}

test('detects the long pause with script context', () => {
  const session = makeSession();
  const report = analyzeSession(session, SCRIPT);
  assert.ok(report.topPauses.length >= 1, 'expected at least one pause');
  assert.ok(report.topPauses[0].durMs >= 6000, `top pause was ${report.topPauses[0].durMs}ms`);
  assert.ok(report.topPauses[0].context.length > 0);
});

test('detects the fumble and merges nearby rewinds', () => {
  const report = analyzeSession(makeSession(), SCRIPT);
  assert.ok(report.fumbles.length >= 1, 'expected a fumble');
  assert.ok(report.fumbles[0].context.length > 0);
});

test('flags the overused word "basically"', () => {
  const report = analyzeSession(makeSession(), SCRIPT);
  const all = [...report.fillers, ...report.overused].map((w) => w.word);
  assert.ok(all.includes('basically'), `expected "basically" in ${JSON.stringify(all)}`);
});

test('detects the skipped passage', () => {
  const report = analyzeSession(makeSession(), SCRIPT);
  assert.ok(report.skipped.length >= 1, 'expected a skipped passage');
  assert.ok(report.skipped[0].words > 8);
});

test('paused ranges are excluded from pause detection', () => {
  const session = makeSession();
  // Mark the long gap as an intentional pause.
  const gapStart = session.activity.find((t, i) => session.activity[i + 1] - t >= 6000);
  session.marks.push({ t: gapStart + 100, type: 'pause' });
  session.marks.push({ t: gapStart + 5900, type: 'resume' });
  const report = analyzeSession(session, SCRIPT);
  assert.ok(!report.topPauses.some((p) => p.durMs >= 6000),
    'intentional pause should not be reported');
});

test('handles empty/degenerate sessions without throwing', () => {
  const empty = { heard: [], activity: [], trace: [], marks: [], elapsedSec: 0, startedAt: 0 };
  const report = analyzeSession(empty, SCRIPT);
  assert.equal(report.totalSpoken, 0);
  assert.equal(report.fumbles.length, 0);
  const noScript = analyzeSession(makeSession(), '');
  assert.ok(noScript.totalSpoken > 0);
});

test('coach prompt contains script, transcript, and stats', () => {
  const session = makeSession();
  const report = analyzeSession(session, SCRIPT);
  const prompt = buildCoachPrompt(session, SCRIPT, report);
  assert.ok(prompt.includes('THE SCRIPT'));
  assert.ok(prompt.includes('reporting engine'));        // script content
  assert.ok(prompt.includes('basically'));               // transcript content
  assert.ok(prompt.includes('Longest pauses'));          // stats
  assert.ok(prompt.length < 200000);
});
