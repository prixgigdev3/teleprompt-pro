// Voice-position matching engine.
//
// The script is tokenized into normalized words. As speech recognition
// produces text, the last few recognized words are aligned against a window
// of the script around the current reading position using a semi-global
// fuzzy alignment (tolerates misrecognized, skipped, and inserted words).
// The best alignment above a confidence threshold becomes the new position.

const NUMBER_WORDS = new Map(Object.entries({
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15',
  sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20',
  thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70',
  eighty: '80', ninety: '90', hundred: '100', thousand: '1000',
}));

export function normalizeWord(raw) {
  let w = String(raw).toLowerCase();
  w = w.replace(/’/g, "'");
  w = w.replace(/[^\p{L}\p{N}']+/gu, '');
  w = w.replace(/^'+|'+$/g, '');
  if (NUMBER_WORDS.has(w)) w = NUMBER_WORDS.get(w);
  return w;
}

// Parse script text into renderable paragraphs and a flat matchable token list.
// paragraphs: array (one per line) of { raw, index } words; index is the
// position in `tokens`, or -1 for words with no matchable content (e.g. "—").
export function parseScript(text) {
  const paragraphs = [];
  const tokens = [];
  for (const line of String(text).split(/\n/)) {
    const words = [];
    for (const raw of line.split(/\s+/)) {
      if (!raw) continue;
      const norm = normalizeWord(raw);
      let index = -1;
      if (norm) {
        index = tokens.length;
        tokens.push(norm);
      }
      words.push({ raw, index });
    }
    paragraphs.push(words);
  }
  return { paragraphs, tokens };
}

// Bounded Levenshtein distance; returns max+1 early when the bound is exceeded.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[n];
}

export function wordsMatch(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (la < 4 || lb < 4) return false;
  // Shared stem: "record" matches "recording", "speak" matches "speaking".
  if (a.startsWith(b) || b.startsWith(a)) return true;
  const max = la >= 8 && lb >= 8 ? 2 : 1;
  return editDistance(a, b, max) <= max;
}

const MATCH = 2;       // aligned words that match
const MISMATCH = -1;   // aligned words that differ (misrecognition)
const GAP_HEARD = -1;  // heard word with no script counterpart (ad-lib, filler)
const GAP_SCRIPT = -0.4; // script word the reader skipped

export class ScriptMatcher {
  constructor(tokens, opts = {}) {
    this.tokens = tokens;
    this.lookahead = opts.lookahead ?? 60;
    this.lookbehind = opts.lookbehind ?? 12;
    this.maxTail = opts.maxTail ?? 10;
    this.position = -1; // index of the last token confirmed read
    this.missStreak = 0;
  }

  reset(position = -1) {
    this.position = position;
    this.missStreak = 0;
  }

  // Feed recently recognized words (raw strings). Returns the updated state.
  feed(words) {
    const tail = words.map(normalizeWord).filter(Boolean).slice(-this.maxTail);
    if (!tail.length || !this.tokens.length) {
      return { position: this.position, moved: false, matched: 0, lost: false };
    }

    // When repeated feeds fail to match, progressively widen the search so a
    // reader who ad-libbed or jumped around can be reacquired. The positional
    // penalty (0.02/token) makes candidates >1000 tokens away unwinnable, so
    // capping the window there only removes dead compute on huge scripts.
    const widen = this.missStreak >= 3
      ? Math.min((this.missStreak - 2) * 80, 1200, this.tokens.length)
      : 0;
    const start = Math.max(0, this.position - this.lookbehind - widen);
    const end = Math.min(this.tokens.length, this.position + 1 + this.lookahead + widen);

    const best = this._align(tail, start, end);
    // Demand that most of the heard tail actually matches: a couple of loose
    // function-word hits ("you", "the", "and") must not anchor the position.
    // While lost (widened search), never accept fewer than 4 matches — a 1-2
    // word interim fragment must not teleport the position across the script.
    let needed = Math.max(widen > 0 ? 4 : 1, Math.ceil(tail.length * 0.6));
    // Short tails may move with less evidence only in the benign case:
    // on-script, normal window. Off-script or far moves get no such discount.
    if (widen === 0 && this.missStreak < 2) {
      needed = Math.min(tail.length, needed);
    }
    if (best) {
      // The further the move, the more evidence it takes. This keeps a
      // speaker who is riffing off-script from being dragged forward by
      // chance hits on common words.
      const jump = best.end - this.position;
      if (jump > 8) needed = Math.max(needed, 3);
      if (jump > 20) needed = Math.max(needed, 4);
      if (jump > 40) needed = Math.max(needed, 5);
      // Recently off-script: any movement at all needs a solid phrase.
      if (this.missStreak >= 2) needed = Math.max(needed, 3);
    }
    const minMatched = needed;
    const accepted =
      best &&
      best.score > 0 &&
      best.matched >= minMatched &&
      // Backward moves are deliberate re-reads: demand more evidence, and
      // accept deeper backward jumps only as the search widens with them.
      (best.end >= this.position ||
        (best.matched >= 3 && best.end >= this.position - this.lookbehind - widen));

    if (!accepted) {
      this.missStreak++;
      return { position: this.position, moved: false, matched: 0, lost: this.missStreak >= 3 };
    }

    this.missStreak = 0;
    const moved = best.end !== this.position;
    this.position = best.end;
    return { position: this.position, moved, matched: best.matched, lost: false };
  }

  // Semi-global alignment: all of `tail` against any substring of
  // tokens[start..end). Returns the best end index, score, and match count.
  _align(tail, start, end) {
    const m = tail.length;
    const L = end - start;
    if (L <= 0) return null;

    let prev = new Float64Array(L + 1); // free leading gap in the script
    let prevCnt = new Int32Array(L + 1);
    for (let i = 1; i <= m; i++) {
      const cur = new Float64Array(L + 1);
      const curCnt = new Int32Array(L + 1);
      cur[0] = prev[0] + GAP_HEARD;
      for (let j = 1; j <= L; j++) {
        const hit = wordsMatch(tail[i - 1], this.tokens[start + j - 1]);
        let v = prev[j - 1] + (hit ? MATCH : MISMATCH);
        let c = prevCnt[j - 1] + (hit ? 1 : 0);
        const up = prev[j] + GAP_HEARD;
        if (up > v) { v = up; c = prevCnt[j]; }
        const left = cur[j - 1] + GAP_SCRIPT;
        if (left > v) { v = left; c = curCnt[j - 1]; }
        cur[j] = v;
        curCnt[j] = c;
      }
      prev = cur;
      prevCnt = curCnt;
    }

    // Prefer alignments near where we expect the reader to be; this keeps
    // repeated phrases ("thank you ... thank you") from yanking the scroll.
    // Feeds are cumulative session transcripts, so typically only ~1 word per
    // feed is new — expecting further ahead makes repetitive text run away.
    const expected = this.position + 1;
    let best = null;
    for (let j = 1; j <= L; j++) {
      const endIdx = start + j - 1;
      const score = prev[j] - Math.abs(endIdx - expected) * 0.02;
      if (!best || score > best.score) {
        best = { score, end: endIdx, matched: prevCnt[j] };
      }
    }
    return best;
  }
}
