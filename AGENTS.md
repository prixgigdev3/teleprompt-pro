# AGENTS.md — Teleprompt Pro

> Machine-facing guide for AI coding agents (Claude Code, Cursor, Codex, Copilot,
> Aider, etc.). Humans: start with [README.md](README.md). Deep technical spec:
> [ARCHITECTURE.md](ARCHITECTURE.md).

Teleprompt Pro is a **voice-following teleprompter**: you paste a script, press
Start, read aloud, and the text scrolls by tracking your voice in real time. It
tolerates stumbles, skips, re-reads, and off-script riffs, and produces a
post-session **delivery report** (pauses, fumbles, filler words, pace).

- **Live app:** https://prixgigdev3.github.io/teleprompt-pro/
- **Repo:** https://github.com/prixgigdev3/teleprompt-pro (public; hosted on GitHub Pages)
- **Stack:** Vanilla HTML + CSS + ES modules. **No build step, no framework, no runtime dependencies.**
- **Node:** only needed to run the test suite (uses the built-in `node:test`, Node ≥ 18).

---

## TL;DR rules for agents

1. **No build tooling.** Do not add webpack/vite/bundlers/TypeScript/React. It is
   plain ES modules loaded directly by the browser. Keep it that way unless the
   user explicitly asks to migrate.
2. **No dependencies.** `package.json` has zero `dependencies`/`devDependencies`.
   Do not add any. Everything is standard browser + Node built-ins.
3. **Serve over HTTP, never `file://`.** The microphone (Web Speech API) requires
   a secure context. Use `python3 server.py 8347` or the live HTTPS URL.
4. **Run the tests after touching `js/matcher.js`, `js/speech.js`, or
   `js/analysis.js`:** `npm test`. These are the pure, unit-tested modules.
5. **Bump the service-worker cache version** (`CACHE` in [sw.js](sw.js)) on every
   release that changes app files, or installed PWAs serve stale code.
6. **All user data is local-only.** Scripts, settings, and session recordings
   live in `localStorage` on the user's device and are **never** uploaded. Do not
   add analytics, telemetry, or any network call that exfiltrates script text.
7. **Secrets:** this repo is **public** and the app has **no API keys** today.
   Never commit real keys. Real values go only in git-ignored `.env.local`;
   `.env.example` holds placeholders. See [SECRETS.md](SECRETS.md). Any future
   paid API must use a user-supplied key (stored in the user's browser) or a
   serverless proxy — never a key hard-coded in `js/`.
8. **Preserve the privacy + offline model.** The only network dependency is
   Chrome's speech-recognition service (voice mode). Everything else works offline.
9. **Match the existing style:** small, commented, dependency-free modules; the
   comments explain *why*, not *what*. Keep that density.

---

## Run, test, deploy

```bash
# Serve locally (no-cache headers so edits show up immediately)
python3 server.py 8347
# → open http://localhost:8347  (use Google Chrome for voice mode)

# Run the test suite (matcher + speech + analysis engines)
npm test          # == node --test tests/*.test.js   (35 tests)

# Deploy: just push to main. GitHub Pages serves the repo root and
# rebuilds in ~1 minute. Then bump sw.js CACHE version so PWAs update.
git push
```

There is **no CI, no lockfile, no transpile**. What is in the repo is what runs.
`Start Teleprompt Pro.command` is a macOS double-click launcher that runs
`server.py` and opens Chrome.

---

## Repository map

```
index.html              Single page; three <section> views (library/editor/prompter) + report view
server.py               Local static server with Cache-Control: no-store (dev only)
manifest.webmanifest    PWA manifest (installable app)
sw.js                   Service worker: network-first cache. BUMP `CACHE` ON RELEASE.
package.json            name + scripts only; zero dependencies
Start Teleprompt Pro.command   macOS launcher

css/style.css           All styles. Apple "liquid glass" UI over a pure-CSS backdrop.

js/                     ES modules, no build:
  matcher.js    Voice→script fuzzy alignment engine (pure, unit-tested)
  speech.js     Web Speech API wrapper (auto-restart, error handling; unit-tested)
  store.js      localStorage: scripts, settings, sessions (pure-ish)
  analysis.js   Post-session report generator + AI coaching prompt (pure, unit-tested)
  prompter.js   Presentation view: rendering, scroll, state machine, recorder, settings
  app.js        Boot + hash router; library, editor, and report views

tests/          node:test unit tests for matcher, speech, analysis
  matcher.test.js  speech.test.js  analysis.test.js

AGENTS.md · ARCHITECTURE.md · CLAUDE.md · README.md   Docs
SECRETS.md · .env.example      Secrets policy + key template (real keys → git-ignored .env.local)
```

Load order: `index.html` → `<script type="module" src="js/app.js">`. `app.js`
imports everything else. There is one entry point.

---

## Architecture in 60 seconds

```
 Web Speech API ──words──▶ SpeechEngine ──onWords(tail)──▶ Prompter.onWords
 (Chrome STT)                                   │
                                                ├─▶ ScriptMatcher.feed(tail) ──▶ {position, moved, lost}
                                                │        (fuzzy-aligns the last ~10 heard words
                                                │         against a window of the script tokens)
                                                ├─▶ move highlight + smooth-scroll to eye-line
                                                └─▶ record {t,pos} into the session
 SpeechEngine ──onFinalWords──▶ Prompter records transcript for the report

 On finish/pause/exit/tab-hide/every-15s:  Prompter.recPersist() → store.saveSession()
 Later:  analysis.analyzeSession(session, scriptText) → report view (#/report/:id)
```

Full detail (algorithm, data model, state machine, invariants) is in
[ARCHITECTURE.md](ARCHITECTURE.md). Read it before changing the matcher, the
speech lifecycle, or the session recorder.

---

## Data model (localStorage — the only persistence)

| Key                | Shape                                   | Notes |
|--------------------|-----------------------------------------|-------|
| `tp_scripts_v1`    | `Script[]`                              | `{id, title, text, createdAt, updatedAt}` |
| `tp_settings_v1`   | `Settings`                              | see `DEFAULT_SETTINGS` in [store.js](js/store.js) |
| `tp_sessions_v1`   | `Session[]` (max 20, newest first)      | recorded takes for reports; upsert by `id` |

A **Session** (see `Prompter.recPersist` in [prompter.js](js/prompter.js) and the
consumer `analyzeSession` in [analysis.js](js/analysis.js)):

```js
{
  id, scriptId, scriptTitle, scriptText,   // self-contained: keeps script text at record time
  startedAt,           // epoch ms
  elapsedSec,          // wall-clock length of the take
  tokensTotal, finalPos,
  words,               // count of spoken words
  heard:   [{ t, w }], // t = ms since take start; w = newly-finalized transcript words
  activity:[ t ],      // timestamps of recognition activity (drives pause detection)
  trace:   [{ t, pos }], // accepted matcher position moves over time
  marks:   [{ t, type, ... }], // 'retake'|'jump'|'lost'|'relock'|'pause'|'resume'|'finish'
}
```

Everything the report needs is inside the session object — reports do not depend
on the live script still existing.

---

## Conventions & invariants (do not break these)

- **`parseScript(text)` returns `{paragraphs, tokens}`.** `tokens` is the flat list
  of normalized, matchable words. Each rendered word carries an `index` into
  `tokens`, or `-1` if non-matchable (punctuation-only, em-dash). The matcher works
  in token-index space; the DOM maps token index → `<span data-i>`.
- **Matcher `position` = index of the last confirmed-read token** (`-1` = not
  started). `feed(words)` is fed the **cumulative** recognized transcript; it only
  looks at the last `maxTail` (10) words.
- **Manual position jumps must flush the recognizer.** `Prompter.manualJump()`
  calls `engine.flush()` so the stale in-flight transcript can't immediately
  re-anchor the matcher at the old spot. Any new jump path must do the same.
- **The prompter reading surface stays a solid color, not glass.** Readability
  while recording beats aesthetics. Glass styling is for the chrome/library only.
- **Sessions/scripts/settings are per-device and never leave the browser.** This is
  a product promise (see README privacy section + `noindex` meta). Keep it true.
- **`analysis.js` and `matcher.js` are pure and Node-testable** (no DOM, no
  browser globals except what's polyfilled in tests). Keep them that way so the
  test suite keeps working.
- **Bump `sw.js` `CACHE`** (`teleprompt-pro-vN`) whenever you change any cached app
  file, and add new files to its `SHELL` array.

---

## Common tasks → where to look

| Task | File(s) |
|------|---------|
| Change how voice tracking follows / re-locks / handles riffs | `js/matcher.js` (algorithm) + `js/prompter.js` `onWords` |
| Speech recognition lifecycle / errors / restart behavior | `js/speech.js` |
| Add a display setting (font, color, alignment, etc.) | `DEFAULT_SETTINGS` in `js/store.js`, the drawer in `index.html`, `applySettings`/`wireSettingsInputs` in `js/prompter.js` |
| Retake / nudge / click-to-jump behavior | `js/prompter.js` (`retake`, `nudge`, `manualJump`, `computeSentenceStarts`) |
| Adaptive scroll speed | `js/prompter.js` (`frame`, `scrollRate` in `onWords`) |
| Session recording / autosave / what's captured | `js/prompter.js` (`recStart`/`recPersist`/`recMark`) + `js/store.js` (`saveSession`) |
| The delivery report content / metrics | `js/analysis.js` (`analyzeSession`) + `renderReport` in `js/app.js` |
| The "Copy AI coaching prompt" text | `buildCoachPrompt` in `js/analysis.js` |
| Routing / views | `js/app.js` (`route`, hash patterns) |
| Styling / theme / backdrop | `css/style.css` |
| PWA / install / offline | `manifest.webmanifest`, `sw.js`, `<head>` of `index.html` |

### Routes (hash-based)
`#/` library · `#/edit/:scriptId` editor · `#/present/:scriptId` prompter ·
`#/reports/:scriptId` session list · `#/report/:sessionId` one report.

---

## Gotchas (learned the hard way)

- **Stale assets in dev:** `server.py` sends `Cache-Control: no-store` on purpose.
  A plain `python3 -m http.server` caused stale-file bugs — don't switch to it.
- **Settings load once at boot** into an in-memory object; `applySettings` writes
  them back. Changing `localStorage` at runtime won't take effect until reload.
- **Voice mode needs internet** (Chrome's recognition runs server-side) and works
  best in **Google Chrome**. Other browsers fall back to auto-scroll.
- **iOS installed PWAs** may restrict speech recognition; Safari tab works.
- **Reports are per-device.** A "where's my report?" bug is usually the user
  looking on a different device than the one they recorded on.
- **A take only becomes a saved session after ~30s and ≥5 matched moves.** It then
  autosaves every ~15s and on pause/finish/exit/tab-hide (`recPersist`).

---

## What this project is NOT

Not a backend app, not a SaaS, no accounts, no database, no server-side code
(the Python file is a dev static server only), no bundler, no CSS framework, no
state library. Resist the urge to "modernize" it into any of those unless asked.
