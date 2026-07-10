# Architecture — Teleprompt Pro

Deep technical reference for anyone (human or agent) modifying the app. For the
quick orientation and rules, read [AGENTS.md](AGENTS.md) first. This document
explains **how each piece works and why it is built the way it is.**

- [1. System overview](#1-system-overview)
- [2. The voice-matching engine (`matcher.js`)](#2-the-voice-matching-engine-matcherjs)
- [3. The speech layer (`speech.js`)](#3-the-speech-layer-speechjs)
- [4. The prompter (`prompter.js`)](#4-the-prompter-prompterjs)
- [5. Persistence (`store.js`)](#5-persistence-storejs)
- [6. Session intelligence (`analysis.js`)](#6-session-intelligence-analysisjs)
- [7. App shell & routing (`app.js`)](#7-app-shell--routing-appjs)
- [8. UI / styling](#8-ui--styling)
- [9. PWA, hosting, deployment](#9-pwa-hosting-deployment)
- [10. Testing](#10-testing)
- [11. Design principles & invariants](#11-design-principles--invariants)
- [12. Extension playbook](#12-extension-playbook)

---

## 1. System overview

A single-page app with four views (library, editor, prompter, report) switched by
hash routing. No build step: the browser loads `js/app.js` as an ES module, which
imports the rest. Zero third-party code.

The one hard external dependency is the browser's **Web Speech API**
(`SpeechRecognition`), used only in voice mode. In Chrome this runs server-side,
so voice mode needs internet; everything else (editing, auto-scroll, reports) is
fully offline and installable as a PWA.

Data flow during a live read:

```
microphone
   │
   ▼
Web Speech API  ──(continuous, interim + final results)──▶  SpeechEngine (speech.js)
                                                              │
              onWords(fullSessionTail) ────────────────────────┤
              onFinalWords(newlyFinalizedWords) ────────────────┤
                                                              ▼
                                                     Prompter (prompter.js)
                                                        │
             ScriptMatcher.feed(tail) ◀──────────────────┤   (matcher.js)
             → { position, moved, lost }                  │
                                                          ├─▶ highlight current word, mark prior read
                                                          ├─▶ ease-scroll so current word sits on the eye-line
                                                          ├─▶ learn reading pace → adaptive scroll cap
                                                          ├─▶ off-script? show "waiting", hold position
                                                          └─▶ append {t,pos} to session.trace
                                                                 │
                                       recPersist() every ~15s / on pause,finish,exit,tab-hide
                                                                 ▼
                                                     store.saveSession()  → localStorage
                                                                 │
                              #/report/:id  ──▶  analyzeSession(session, scriptText)  (analysis.js)
                                                                 ▼
                                                   report view rendered by app.js
```

---

## 2. The voice-matching engine (`matcher.js`)

The core algorithm. Pure, no DOM, fully unit-tested. It answers one question on
every speech update: **given the words we just heard, where in the script is the
reader now?**

### 2.1 Tokenization

- `normalizeWord(raw)` → lowercase, curly→straight apostrophe, strip everything
  except letters/digits/apostrophes, map spelled-out numbers ("twenty"→"20").
  Returns `''` for non-word tokens (e.g. `—`).
- `parseScript(text)` → `{ paragraphs, tokens }`.
  - `tokens`: flat array of normalized **matchable** words. This is the coordinate
    space the matcher and the whole app use ("position" = index into `tokens`).
  - `paragraphs`: one entry per input line; each is a list of `{ raw, index }`
    where `index` is the position in `tokens`, or `-1` for non-matchable words.
    This is what the prompter renders, keeping display and match-space in lockstep.

### 2.2 Fuzzy word equality — `wordsMatch(a, b)`

Speech-to-text is noisy, so equality is fuzzy:
- exact match, OR
- shared prefix/stem (≥4 chars): "record" ≈ "recording", OR
- bounded Levenshtein distance ≤ 1 (≤ 2 for words ≥ 8 chars).
- Words < 4 chars must match exactly (prevents "the"/"then"/"that" chaos).

`editDistance` is a classic DP with an early-exit bound (returns `max+1` as soon
as a row's minimum exceeds the bound) so it's cheap.

### 2.3 Alignment — `_align(tail, start, end)`

A **semi-global (overlap) alignment** by dynamic programming: align *all* of the
heard `tail` against the *best substring* of `tokens[start..end)`.

- Scores: `MATCH=+2`, `MISMATCH=-1`, `GAP_HEARD=-1` (a heard word absent from the
  script — an ad-lib/filler), `GAP_SCRIPT=-0.4` (a script word the reader skipped —
  cheap, because skipping ahead is normal and expected).
- Leading script gap is free (the tail can start anywhere in the window); the tail
  is consumed fully (all heard words are accounted for). Two `Float64Array` rows +
  two `Int32Array` rows track score and match-count with O(tail × window) time.
- Among all end positions, it picks the best `score`, applying a small
  **positional penalty** `-0.02 × |endIdx − expected|` where `expected = position + 1`.
  This tiebreaker keeps repeated phrases ("thank you … thank you") from yanking the
  scroll to the wrong occurrence, and — because feeds are cumulative and typically
  only ~1 word is new per feed — stops repetitive text from running away.

Returns `{ score, end, matched }`.

### 2.4 Acceptance & reacquisition — `feed(words)`

`feed` is called with the **cumulative** recognized transcript; it normalizes and
keeps the last `maxTail` (10) words as `tail`.

- **Search window:** normally `[position − lookbehind(12), position + 1 + lookahead(60))`.
  After `missStreak ≥ 3` (repeated non-matches) it **widens** by `(missStreak−2)×80`,
  capped at 1200 tokens (beyond that the positional penalty makes a match
  unwinnable, so wider is dead compute) and at the script length. This is how a
  reader who jumped or ad-libbed gets reacquired.
- **Evidence required (`minMatched`)** scales with risk:
  - baseline `ceil(tail.length × 0.6)`; while lost (widened) at least 4.
  - larger jumps demand more: `>8 → ≥3`, `>20 → ≥4`, `>40 → ≥5`.
  - recently off-script (`missStreak ≥ 2`) → any move needs ≥3.
  - This is the **riff protection**: chance hits on common words can't drag the
    position while you're improvising.
- **Backward moves** (deliberate re-reads) require ≥3 matches and the target must be
  within `lookbehind + widen` behind the current position.
- On accept: `position = best.end`, `missStreak = 0`. On reject: `missStreak++`.
- **Returns** `{ position, moved, matched, lost }`. `lost` (true once `missStreak ≥ 3`)
  drives the prompter's "Off-script — waiting" indicator.

`reset(position)` sets the position directly (used for manual jumps / retakes).

### 2.5 Why cumulative feeds matter

Chrome delivers the growing transcript of the current recognition *session* on
every event. `feed` therefore sees the same early words repeatedly and only the
tail changes. The matcher is designed around this: it never assumes the whole tail
is new speech, and manual jumps flush the recognizer (§3) so a stale transcript
can't re-anchor the old position.

---

## 3. The speech layer (`speech.js`)

`SpeechEngine` wraps `webkitSpeechRecognition`/`SpeechRecognition` and hides its
rough edges. Unit-tested with a fake recognizer.

- **Callbacks:** `onWords(words)` (full word stream of the current session — fed to
  the matcher), `onFinalWords(words)` (only newly-*finalized* words — appended to
  the session transcript for the report), `onState(state)`, `onError(code)`.
- **Continuous with auto-restart:** Chrome ends `continuous` sessions after silence
  or a few minutes. `onend` re-spins while `active`. Because the matcher only reads
  the tail, a mid-read session reset is invisible to tracking.
- **`_spin()`** always `_teardown()`s first (detaches handlers, aborts the old
  instance) so a live recognizer with attached handlers can never leak — this was a
  real double-recognizer bug source.
- **`flush()`** tears down and re-spins immediately, giving an empty transcript.
  Called on manual position jumps and language changes so stale words don't
  re-anchor the matcher.
- **Restart backoff:** only sessions that die **< 3s** after starting count toward
  instability (`_recentRestarts`); long sessions that ended from silence reset it.
  After repeated fast deaths the retry delay grows to 2s and every 12th emits an
  `'unstable'` warning. This distinguishes "no internet" from "normal silence".
- **Error mapping:** `not-allowed`/`service-not-allowed` → `mic-denied` (fatal);
  `audio-capture` → `no-mic` (fatal); `language-not-supported` → `bad-lang` (fatal);
  `network` → transient warning; `no-speech`/`aborted` → routine (handled by
  `onend`). Fatal errors set `active=false` and stop retrying.

---

## 4. The prompter (`prompter.js`)

The largest module: owns the presentation DOM, the scroll animation, the state
machine, the session recorder, and the settings drawer. A **single instance is
reused** across presentations (`app.js`): the constructor wires DOM listeners
once; `open(script, settings)` and `close()` set up/tear down per-visit state and
per-visit event listeners.

### 4.1 State machine

`state ∈ { idle, countdown, running, paused, done }`, `mode ∈ { voice, auto }`.

```
 idle ──Start──▶ (countdown?) ──▶ running ──Pause──▶ paused ──Resume──▶ running
   ▲                                  │  │                                  │
   │                                  │  └──reach last token──▶ done ──Start over──▶ (restart) idle
   └──────────────── restart ─────────┘         │
                                        Start over│
```

- **Countdown** (`runCountdown`) is an abortable promise; the overlay has
  `pointer-events:none` so the Start/Cancel button underneath stays clickable.
- **Timer/WPM** (`updateTimer`, every 500ms): elapsed time plus a rolling
  words-per-minute over the last 45s that estimates time remaining.

### 4.2 Voice tracking loop (`onWords`)

1. Record recognition activity timestamps (throttled) for pause detection.
2. `matcher.feed(words)` → result.
3. **Off-script handling:** `result.lost` toggles the "Off-script — waiting" pill
   and a `lost`/`relock` mark; the position holds until a solid phrase re-locks.
4. On `moved`: update highlight/read classes, retarget the scroll, **learn the
   reading pace** (`scrollRate`, an EMA of px/s between moves), append `{t,pos}` to
   `session.trace`, and `finish()` if the last token was reached.

### 4.3 Adaptive scrolling (`frame`)

A `requestAnimationFrame` loop eases `scrollEl.scrollTop` toward `scrollTarget`
(the offset that puts the current word on the eye-line). The catch-up velocity is
**capped to the measured reading pace** (`scrollRate`), so a burst of matched
words glides instead of snapping — except right after a manual jump (`snapNext`),
which snaps at full speed. Auto mode instead advances at a constant `autoSpeed`.

### 4.4 Retake, nudge, click-to-jump (`manualJump`)

- **Retake** (`↩` button / `B` / `Backspace`): jump to the start of the current
  sentence (or the previous one if already at the top). Sentence starts are
  precomputed by `computeSentenceStarts(paragraphs)` (first token, paragraph
  starts, and tokens after sentence-ending punctuation).
- **Nudge** (`↑`/`↓`), **click any word**: also route through `manualJump`.
- **`manualJump(pos)`** resets the matcher, repaints, resets pace learning,
  **`engine.flush()`es** the recognizer, and records a `jump`/`retake` mark.

### 4.5 The session recorder

While reading in voice mode, the prompter records a **Session** (shape in
[AGENTS.md](AGENTS.md#data-model-localstorage--the-only-persistence)):

- `recStart()` initializes the record at Start.
- `onWords`/`onFinalWords` append to `trace`/`activity`/`heard`; `recMark` logs
  `retake|jump|lost|relock|pause|resume|finish`.
- **`recPersist()`** is the durability guarantee. It saves the take (upsert by id)
  **when it first crosses ~30s and ≥5 moves, then every ~15s, and on pause, finish,
  exit, and `pagehide`/`visibilitychange→hidden`.** This is why closing the tab or
  backgrounding the app no longer loses a recording — the original "I read for 30
  min and saw no report" bug. Quota failures surface a toast instead of silently
  failing.

### 4.6 Settings drawer

`applySettings` maps the settings object to CSS custom properties (`--tp-*`) and
persists it. Read-word visibility is a `color-mix` between text and background.
`wireSettingsInputs`/`syncSettingsInputs` bind the drawer controls. Keyboard: see
`onKeydown` (Space, ↑/↓, +/−, M, F, R, S, B, Esc), all ignored while typing in a
field and when a browser modifier is held.

---

## 5. Persistence (`store.js`)

Thin, defensive `localStorage` layer. `read`/`write` swallow exceptions (private
mode / quota / blocked storage) and return safe fallbacks, so the app degrades to
"empty but working" rather than crashing.

- **Scripts** (`tp_scripts_v1`): `listScripts/getScript/saveScript/deleteScript/newScript`.
- **Settings** (`tp_settings_v1`): `loadSettings` merges over `DEFAULT_SETTINGS`;
  `saveSettings`.
- **Sessions** (`tp_sessions_v1`): `saveSession` **upserts by `id`** (checkpointing
  a take repeatedly updates one record), caps at `MAX_SESSIONS = 20`, and on quota
  failure drops the oldest sessions until the new one fits.
- `ensureSampleScript()` seeds the demo script only when the key is truly absent
  (guarded against throwing when storage is blocked).

All keys are versioned (`_v1`); change the suffix if a migration is ever needed.

---

## 6. Session intelligence (`analysis.js`)

Pure functions, unit-tested. `analyzeSession(session, scriptText)` turns a
recorded take into a report object:

- **Pauses:** gaps ≥ 2.5s in `activity`, excluding ranges the user explicitly
  paused (overlap-tested), each tagged with the script line the reader stopped on.
- **Fumbles:** backward moves in `trace` + explicit `retake` marks, merged into
  episodes within a 15s / 25-token window.
- **Off-script episodes:** derived from `lost`/`relock` marks.
- **Skipped passages:** forward `trace` jumps > 8 tokens → the script text in between.
- **Overused words / fillers:** spoken-word frequency vs. what the script actually
  contains; a curated filler list ("basically", "like", "um" …) plus any word said
  far more than the script uses it.
- **Pace:** words read per minute, minute by minute; plus totals, avg WPM, coverage %.

`buildCoachPrompt(session, scriptText, report)` assembles a self-contained prompt
(script + actual transcript + measured stats) the user can paste into Claude/any
LLM for the qualitative layer ("which sentences didn't land, why the fumbles").
This is the boundary between the app's deterministic metrics and LLM judgment —
the natural place to later wire a direct API call.

---

## 7. App shell & routing (`app.js`)

- **Boot:** load settings once, `ensureSampleScript()`, `route()`, register the
  service worker, warn if opened via `file://`.
- **Hash router** (`route` on `hashchange`): `#/` library, `#/edit/:id` editor,
  `#/present/:id` prompter, `#/reports/:scriptId` session list, `#/report/:id` one
  report. Navigating away calls `prompter.close()` (which persists the take) and
  flushes the editor autosave.
- **Single reused Prompter** via `PrompterSingleton()`.
- **Library:** cards with Present / Edit / 📊 reports (count) / Delete.
- **Editor:** debounced autosave (400ms) + `beforeunload` flush; saves only commit
  to the in-memory script on a successful write, so a failed save stays dirty and
  retries (avoids silent data loss).
- **Report views:** `renderSessionList` and `renderReport` (stat chips, pace
  sparkline as inline SVG, pauses/fumbles/fillers/skips, and the "Copy AI coaching
  prompt" button).

---

## 8. UI / styling

`css/style.css`, no framework. Apple "liquid glass" aesthetic: translucent
`backdrop-filter` panels, an Intelligence-style blue→purple→pink gradient on
primary actions, over a **pure-CSS backdrop** (`body::before` — orange + blue
radial glows behind vertical "fluted glass" ribs; no image asset, so it's crisp at
any resolution). Theme values live in `:root` custom properties.

**The prompter reading surface is deliberately solid** (user-chosen colors), not
glass — legibility while recording wins over decoration. Mirror mode
(`scaleX(-1)`) supports beam-splitter rigs and also flips the countdown digits so
talent reads them correctly.

---

## 9. PWA, hosting, deployment

- **Installable:** `manifest.webmanifest` + icons + apple-touch meta in `<head>`.
  Installs to macOS Dock (Chrome) or iOS/iPadOS home screen (Safari → Add to Home
  Screen).
- **Service worker** (`sw.js`): **network-first**, falling back to cache — so an
  online load always gets fresh code, and the shell still opens offline. The
  `SHELL` array is precached on install; old caches are purged on activate.
  **On every release you MUST bump `CACHE` (`teleprompt-pro-vN`)** and add any new
  files to `SHELL`, or installed apps serve stale assets.
- **Hosting:** GitHub Pages serving the repo root of `main`. **Push to `main` =
  deploy** (~1 min rebuild). No CI. `<meta name="robots" content="noindex">` keeps
  the URL out of search engines (it's a personal app, though the code is public).
- **Local dev:** `server.py` (sets `Cache-Control: no-store` to avoid stale-asset
  confusion). `Start Teleprompt Pro.command` is the macOS launcher.

---

## 10. Testing

`npm test` → `node --test tests/*.test.js` (Node ≥ 18, built-in test runner, no
deps). Three suites cover the pure/testable cores:

- `matcher.test.js` — tokenization, fuzzy equality, and the hard tracking cases:
  perfect read, misrecognitions, skipped sentences, ad-libs, big jumps, repeated
  phrases, backward re-reads, riff-drift protection, gibberish, degenerate input.
- `speech.test.js` — the recognizer lifecycle via a fake `SpeechRecognition`:
  auto-restart, detach-on-stop, mic-denied, instability backoff, `flush`.
- `analysis.test.js` — pauses, fumble merging, overused words, skips, paused-range
  exclusion, empty sessions, coach-prompt assembly.

The DOM-coupled modules (`prompter.js`, `app.js`) are verified by driving the real
app in a browser (a fake `SpeechRecognition` can simulate a read-through end to
end). There is no jsdom harness.

---

## 11. Design principles & invariants

1. **Dependency-free, build-free, backend-free.** Portability and longevity over
   convenience. Anything that adds a toolchain or a server is out of scope unless
   the user asks.
2. **Local-first & private.** All user content stays in `localStorage` on the
   device; nothing is uploaded. The only network use is Chrome's STT in voice mode.
3. **Token-index space is the source of truth.** Display, matching, scrolling, and
   session traces all reference `tokens` indices. Keep `paragraphs[].index` aligned
   with `tokens`.
4. **The reader is never blocked.** Every automatic behavior (tracking, off-script
   hold, adaptive scroll) has a manual override (retake, nudge, click-to-jump, auto
   mode). Failures degrade gracefully (voice→auto, blocked storage→empty library).
5. **Never lose a take.** `recPersist` checkpoints continuously and on tab
   hide/close. Preserve this whenever you touch the recorder.
6. **Manual jump ⇒ flush the recognizer.** Otherwise the stale transcript undoes
   the jump.
7. **Comments explain intent.** The codebase is deliberately commented at the "why"
   level. Match that density; it is how the next agent understands the tradeoffs.

---

## 12. Extension playbook

- **Cloud speech engine (accuracy upgrade):** add a `DeepgramEngine`/`WhisperEngine`
  with the same `SpeechEngine` interface (`onWords`, `onFinalWords`, `start/stop/flush`,
  `setLanguage`). The matcher and prompter don't care where words come from.
- **Built-in AI report analysis:** replace the copy-paste `buildCoachPrompt` with a
  direct API call (user-supplied key), rendering the qualitative feedback inline in
  the report view. The prompt content already exists.
- **Cross-device sync:** the app is local-first by design. Any sync must be
  explicit and privacy-preserving (e.g. user-initiated export/import, or an
  end-to-end path) — do not silently upload script text.
- **Native App Store build:** wrap the existing web app with Capacitor (reuses
  ~95% of the code) rather than rewriting in React Native. iPad build also runs on
  Apple-silicon Macs.
- **New settings:** add to `DEFAULT_SETTINGS`, add the control to the drawer in
  `index.html`, bind it in `wireSettingsInputs`/`syncSettingsInputs`, and apply it
  in `applySettings` (usually a `--tp-*` CSS var).

When in doubt, read the module's top-of-file comment and the inline comments — they
state the intent behind the tradeoffs.
