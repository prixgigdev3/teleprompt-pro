// Post-session analysis: turns a recorded read-through (timestamped spoken
// words, position trace, event marks) into actionable feedback — pauses,
// fumbles, overused words, skipped passages, and pace over time.

import { parseScript, normalizeWord } from './matcher.js';

const PAUSE_MS = 2500;          // silence longer than this counts as a pause
const SKIP_TOKENS = 8;          // forward trace jumps bigger than this = skipped text
const FUMBLE_MERGE_MS = 15000;  // backward moves within this window merge into one fumble

// Words too common to be interesting on their own.
const STOPWORDS = new Set(('the a an and or but if then than that this these those ' +
  'i you he she it we they me him her us them my your his its our their ' +
  'is are was were be been being am do does did have has had will would can ' +
  'could should shall may might must to of in on at by for with from as into ' +
  'about over after before between out up down off not no yes ' +
  "it's i'm you're we're they're don't doesn't didn't can't won't isn't").split(/\s+/));

// Filler/crutch words worth counting even though they are common.
const FILLERS = ['like', 'basically', 'actually', 'literally', 'obviously', 'honestly',
  'right', 'okay', 'so', 'well', 'just', 'really', 'very', 'kind', 'sort', 'stuff',
  'things', 'amazing', 'incredible', 'whatever', 'anyway', 'um', 'uh', 'yeah'];

function tokenAt(trace, t) {
  let pos = -1;
  for (const p of trace) {
    if (p.t > t) break;
    pos = p.pos;
  }
  return pos;
}

function snippet(rawWords, center, before = 4, after = 6) {
  const start = Math.max(0, center - before);
  const end = Math.min(rawWords.length, center + after);
  const text = rawWords.slice(start, end).join(' ');
  return (start > 0 ? '…' : '') + text + (end < rawWords.length ? '…' : '');
}

// Flatten the script into raw words indexed by matchable-token position.
function rawByToken(scriptText) {
  const { paragraphs } = parseScript(scriptText);
  const raw = [];
  for (const words of paragraphs) {
    for (const w of words) {
      if (w.index >= 0) raw[w.index] = w.raw;
    }
  }
  return raw;
}

// Time ranges during which the reader had explicitly paused the prompter.
function pausedRanges(marks, endT) {
  const ranges = [];
  let openAt = null;
  for (const m of marks || []) {
    if (m.type === 'pause' && openAt === null) openAt = m.t;
    if (m.type === 'resume' && openAt !== null) {
      ranges.push([openAt, m.t]);
      openAt = null;
    }
  }
  if (openAt !== null) ranges.push([openAt, endT]);
  return ranges;
}

function overlapsRanges(a, b, ranges) {
  return ranges.some(([x, y]) => a < y && b > x);
}

export function analyzeSession(session, scriptText) {
  const text = scriptText ?? session.scriptText ?? '';
  const { tokens } = parseScript(text);
  const raw = rawByToken(text);
  const trace = session.trace || [];
  const activity = session.activity || [];
  const marks = session.marks || [];
  const durationSec = session.elapsedSec ||
    (trace.length ? trace[trace.length - 1].t / 1000 : 0);
  const endT = durationSec * 1000;
  const paused = pausedRanges(marks, endT);

  // ----- spoken transcript -----
  const spoken = [];
  for (const h of session.heard || []) {
    for (const word of h.w.split(/\s+/)) {
      const norm = normalizeWord(word);
      if (norm) spoken.push({ t: h.t, norm });
    }
  }
  const totalSpoken = spoken.length;
  const avgWpm = durationSec > 30 ? Math.round(totalSpoken / (durationSec / 60)) : null;

  // ----- pauses: gaps in recognition activity -----
  const pauses = [];
  for (let i = 1; i < activity.length; i++) {
    const gap = activity[i] - activity[i - 1];
    if (gap >= PAUSE_MS && !overlapsRanges(activity[i - 1], activity[i], paused)) {
      const pos = tokenAt(trace, activity[i - 1]);
      pauses.push({
        t: activity[i - 1],
        durMs: gap,
        pos,
        context: pos >= 0 ? snippet(raw, pos) : '(at the very start)',
      });
    }
  }
  pauses.sort((a, b) => b.durMs - a.durMs);
  const topPauses = pauses.slice(0, 8);

  // ----- fumbles: backward moves + explicit retakes, merged into episodes -----
  const backMoves = [];
  for (let i = 1; i < trace.length; i++) {
    if (trace[i].pos < trace[i - 1].pos) {
      backMoves.push({ t: trace[i].t, from: trace[i - 1].pos, to: trace[i].pos });
    }
  }
  for (const m of marks) {
    if (m.type === 'retake') backMoves.push({ t: m.t, from: m.from, to: m.to, retake: true });
  }
  backMoves.sort((a, b) => a.t - b.t);
  const fumbles = [];
  for (const mv of backMoves) {
    const last = fumbles[fumbles.length - 1];
    if (last && mv.t - last.t < FUMBLE_MERGE_MS && Math.abs(mv.to - last.pos) < 25) {
      last.count++;
      last.t = mv.t;
      last.pos = Math.min(last.pos, mv.to);
    } else {
      fumbles.push({ t: mv.t, pos: mv.to, count: 1, retake: !!mv.retake });
    }
  }
  for (const f of fumbles) f.context = f.pos >= 0 ? snippet(raw, f.pos) : '(start)';

  // ----- off-script episodes -----
  let offScript = 0;
  let lostAt = null;
  let offScriptMs = 0;
  for (const m of marks) {
    if (m.type === 'lost' && lostAt === null) lostAt = m.t;
    if (m.type === 'relock' && lostAt !== null) {
      offScript++;
      offScriptMs += m.t - lostAt;
      lostAt = null;
    }
  }
  if (lostAt !== null) { offScript++; offScriptMs += endT - lostAt; }

  // ----- skipped passages -----
  const skipped = [];
  for (let i = 1; i < trace.length; i++) {
    const gap = trace[i].pos - trace[i - 1].pos;
    if (gap > SKIP_TOKENS) {
      const from = trace[i - 1].pos + 1;
      const to = trace[i].pos - 1;
      skipped.push({
        from, to,
        words: to - from + 1,
        context: snippet(raw, from, 0, Math.min(14, to - from + 1)),
      });
    }
  }

  // ----- overused words and fillers -----
  const spokenCounts = new Map();
  for (const s of spoken) {
    spokenCounts.set(s.norm, (spokenCounts.get(s.norm) || 0) + 1);
  }
  const scriptCounts = new Map();
  for (const tok of tokens) {
    scriptCounts.set(tok, (scriptCounts.get(tok) || 0) + 1);
  }
  const overused = [];
  for (const [word, count] of spokenCounts) {
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    const inScript = scriptCounts.get(word) || 0;
    if (count >= 4 && count >= inScript * 2 + 2) {
      overused.push({ word, spoken: count, inScript });
    }
  }
  overused.sort((a, b) => b.spoken - a.spoken);

  const fillers = [];
  for (const f of FILLERS) {
    const count = spokenCounts.get(f) || 0;
    const inScript = scriptCounts.get(f) || 0;
    if (count >= 3 && count > inScript) {
      fillers.push({ word: f, spoken: count, inScript });
    }
  }
  fillers.sort((a, b) => (b.spoken - b.inScript) - (a.spoken - a.inScript));

  // ----- pace per minute -----
  const pace = [];
  if (trace.length && durationSec > 90) {
    const minutes = Math.ceil(durationSec / 60);
    for (let m = 0; m < minutes; m++) {
      const a = tokenAt(trace, m * 60000);
      const b = tokenAt(trace, (m + 1) * 60000);
      pace.push(Math.max(0, b - a));
    }
  }

  const finalPos = trace.length ? trace[trace.length - 1].pos : -1;
  const skippedWords = skipped.reduce((n, s) => n + s.words, 0);
  const coverage = tokens.length
    ? Math.round(((Math.max(0, finalPos + 1) - skippedWords) / tokens.length) * 100)
    : 0;

  return {
    durationSec: Math.round(durationSec),
    totalSpoken,
    avgWpm,
    coverage: Math.max(0, Math.min(100, coverage)),
    scriptWords: tokens.length,
    finalPos,
    topPauses,
    pauseCount: pauses.length,
    fumbles,
    offScript,
    offScriptSec: Math.round(offScriptMs / 1000),
    skipped: skipped.slice(0, 8),
    overused: overused.slice(0, 10),
    fillers: fillers.slice(0, 10),
    pace,
  };
}

// A self-contained prompt the user can paste into Claude (or any AI) for the
// qualitative layer: which sentences didn't land, why the fumbles happened,
// and concrete rewrites.
export function buildCoachPrompt(session, scriptText, report) {
  const transcript = (session.heard || []).map((h) => h.w).join(' ');
  const fmt = (s) => Math.floor(s / 60) + 'm' + String(Math.round(s % 60)).padStart(2, '0') + 's';
  const statLines = [
    `Duration: ${fmt(report.durationSec)} · ${report.totalSpoken} words spoken · avg ${report.avgWpm ?? '?'} wpm · ${report.coverage}% of script covered`,
    report.topPauses.length
      ? 'Longest pauses: ' + report.topPauses.slice(0, 5).map((p) => `${(p.durMs / 1000).toFixed(1)}s near "${p.context}"`).join(' | ')
      : 'No long pauses.',
    report.fumbles.length
      ? 'Fumble spots: ' + report.fumbles.slice(0, 6).map((f) => `near "${f.context}"`).join(' | ')
      : 'No fumbles detected.',
    report.fillers.length
      ? 'Crutch words: ' + report.fillers.map((f) => `${f.word}×${f.spoken}`).join(', ')
      : '',
    report.skipped.length
      ? 'Skipped passages: ' + report.skipped.map((s) => `"${s.context}"`).join(' | ')
      : '',
  ].filter(Boolean).join('\n');

  return `You are a speaking and on-camera delivery coach. I just recorded a video reading the script below from a teleprompter. I'm including the script, the transcript of what I actually said (from speech recognition, so expect some transcription noise), and stats my teleprompter measured.

Give me specific, practical feedback:
1. Which sentences in the script didn't land or don't make sense as spoken — quote them and suggest a rewrite that's easier to say out loud.
2. Look at where I paused and fumbled — what about the script (or my delivery) likely caused each one?
3. Which words or phrases do I lean on too much, and what should I say instead?
4. Anything I said off-script that was actually BETTER than the script — should I keep it?
5. Top 3 changes for my next take.

=== MEASURED STATS ===
${statLines}

=== THE SCRIPT ===
${scriptText}

=== WHAT I ACTUALLY SAID (speech-to-text) ===
${transcript}`;
}

// Collapse a context snippet to a stable key so the same spot across different
// takes aggregates together (ignores the leading/trailing "…", punctuation, case).
function locationKey(context) {
  return String(context).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

// Aggregate MANY recorded sessions into cross-take patterns: which script spots
// the reader stops at most, and which passages they skip most. Grouped by
// script, ranked by how many distinct takes each spot recurs in.
export function aggregateInsights(sessions) {
  const byScript = new Map();
  for (const s of sessions || []) {
    if (!byScript.has(s.scriptId)) byScript.set(s.scriptId, []);
    byScript.get(s.scriptId).push(s);
  }

  const scripts = [];
  for (const [scriptId, group] of byScript) {
    const stops = new Map();   // key -> { context, takes:Set, times, totalMs, maxMs }
    const skips = new Map();   // key -> { context, takes:Set, times, words }

    for (const session of group) {
      const report = analyzeSession(session, session.scriptText);
      for (const p of report.topPauses) {
        const key = locationKey(p.context);
        if (!key) continue;
        const e = stops.get(key) || { context: p.context, takes: new Set(), times: 0, totalMs: 0, maxMs: 0 };
        e.times++; e.takes.add(session.id); e.totalMs += p.durMs; e.maxMs = Math.max(e.maxMs, p.durMs);
        if (p.context.length > e.context.length) e.context = p.context;
        stops.set(key, e);
      }
      for (const sk of report.skipped) {
        const key = locationKey(sk.context);
        if (!key) continue;
        const e = skips.get(key) || { context: sk.context, takes: new Set(), times: 0, words: 0 };
        e.times++; e.takes.add(session.id); e.words = Math.max(e.words, sk.words);
        if (sk.context.length > e.context.length) e.context = sk.context;
        skips.set(key, e);
      }
    }

    const mostStoppedAt = [...stops.values()]
      .map((e) => ({ context: e.context, takes: e.takes.size, times: e.times,
        avgSec: (e.totalMs / e.times) / 1000, maxSec: e.maxMs / 1000 }))
      .sort((a, b) => b.takes - a.takes || b.times - a.times || b.maxSec - a.maxSec)
      .slice(0, 12);
    const mostSkipped = [...skips.values()]
      .map((e) => ({ context: e.context, takes: e.takes.size, times: e.times, words: e.words }))
      .sort((a, b) => b.takes - a.takes || b.times - a.times || b.words - a.words)
      .slice(0, 12);

    scripts.push({
      scriptId,
      scriptTitle: group[0].scriptTitle || 'Untitled script',
      takes: group.length,
      mostStoppedAt,
      mostSkipped,
    });
  }

  scripts.sort((a, b) => b.takes - a.takes);
  return { totalSessions: (sessions || []).length, scripts };
}
