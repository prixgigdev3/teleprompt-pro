# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repo.

**Read [AGENTS.md](AGENTS.md) first** — it is the canonical agent guide (rules,
run/test/deploy, repo map, data model, conventions, gotchas). For the deep
technical spec of how everything works, read [ARCHITECTURE.md](ARCHITECTURE.md).
For the human/product overview, see [README.md](README.md).

## Fast facts

- **Teleprompt Pro** — a voice-following teleprompter PWA. Vanilla HTML/CSS/ES
  modules. **No build, no framework, no dependencies.**
- **Live:** https://prixgigdev3.github.io/teleprompt-pro/ · **Deploy:** push to `main` (GitHub Pages, ~1 min).
- **Run locally:** `python3 server.py 8347` → http://localhost:8347 (use Chrome for voice).
- **Test:** `npm test` (`node --test tests/*.test.js`, Node ≥ 18) after touching
  `js/matcher.js`, `js/speech.js`, or `js/analysis.js`.

## Non-negotiables

- Don't add build tooling, frameworks, or dependencies.
- Don't add telemetry or any network call that sends script text off-device —
  all user data is local-only `localStorage` by design.
- Bump `CACHE` in [sw.js](sw.js) on any release that changes app files.
- After editing a browser-visible file, verify in a browser (serve over HTTP,
  never `file://` — the mic needs a secure context).
- Keep modules small, pure where they already are (`matcher`, `analysis`,
  `speech`), and commented at the "why" level.

## Where things live

`js/matcher.js` voice→script alignment · `js/speech.js` Web Speech wrapper ·
`js/store.js` localStorage · `js/prompter.js` presentation + recorder ·
`js/analysis.js` report engine · `js/app.js` routing/library/editor/report ·
`css/style.css` styling · `index.html` views. Full map in AGENTS.md.
