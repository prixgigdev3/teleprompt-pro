# 🎙️ Teleprompt Pro

A teleprompter that **follows your voice**. Add a script, press Start, and read —
the text scrolls along with you. If you stumble, skip a sentence, or improvise
for a moment, the prompter waits and picks up the instant you return to the script.

**Live app:** https://prixgigdev3.github.io/teleprompt-pro/

## How to launch

**Double-click `Start Teleprompt Pro.command`** in this folder.

It starts a tiny local server and opens the app in Chrome. The first time you
press Start, Chrome will ask for microphone access — click **Allow**.

> macOS may warn the first time you open the `.command` file. If so:
> right-click it → **Open** → **Open**. You only need to do this once.

## Using the app

1. **Library** — your scripts live here, saved in the browser. Click **+ New script**.
2. **Editor** — paste or type your script. It saves automatically as you type.
3. **Present** — press **Start** (or `Space`). After the countdown, just read aloud.

### While presenting

| Control | Action |
|---|---|
| `Space` | Start / pause |
| `↑` / `↓` | Nudge position back / forward |
| `+` / `−` | Font size |
| `B` / `Backspace` | ↩ Retake — jump back a sentence and re-read |
| `M` | Switch voice ↔ auto-scroll mode |
| `F` | Fullscreen |
| `R` | Restart from the top |
| `S` | Settings drawer |
| `Esc` | Exit |
| Click any word | Jump there |

The **A− / A+** buttons in the top bar resize the text instantly (or use the
`+` / `−` keys). The **⚙ settings** drawer has font size, line spacing,
margins, eye-line position, **text alignment (left / center / right)**, colors,
language, countdown length, auto-scroll speed, and a mirror mode for
beam-splitter teleprompter rigs.

The yellow arrow on the left marks the **eye line** — the current word is kept
there so your eyes never wander far from the camera.

## Install it as an app

Teleprompt Pro is a PWA — it installs like a real app, no app store needed:

- **Mac (Chrome):** with the app open, click the **install icon** at the right
  end of the address bar (or ⋮ menu → *Cast, save and share* → *Install page as
  app*). It gets its own Dock icon and window.
- **iPhone / iPad:** open https://prixgigdev3.github.io/teleprompt-pro/ in
  Safari → Share → **Add to Home Screen**. It launches full-screen with the
  app icon. (If voice mode won't start inside the installed app on older iOS
  versions, use it directly in Safari — Apple restricts speech recognition in
  home-screen apps on some versions. Auto-scroll mode always works.)

## Session reports 📊

Read in voice mode for a minute or more and the session is recorded (locally,
like everything else). Press **📊** in the prompter when you finish — or the
**📊 n** button on the script's library card — to see:

- your longest **pauses**, with the exact script line you stopped at
- **fumble hotspots** — where you rewound or retook lines
- **words you lean on** (fillers and crutch words vs. what the script asks for)
- **skipped passages** the prompter never heard you read
- **pace minute-by-minute** and overall stats

**✦ Copy AI coaching prompt** bundles your script, the transcript of what you
actually said, and the stats into one prompt — paste it into Claude for the
qualitative layer: which sentences don't work out loud, why the fumbles
happened, and what to change in the next take.

While presenting, going off-script flips the status pill to **“Off-script —
waiting”**; the prompter holds position until you speak a solid phrase from
the script again, then re-locks. The scroll speed also adapts to your reading
pace — faster when you speed up, gentler when you slow down.

## Good to know

- **Use Google Chrome** for voice tracking. (Chrome's speech recognition needs
  an internet connection; everything else works offline.)
- Voice mode shows a small **"Listening"** pill — and, optionally, the words it
  hears — in the bottom bar, so you can confirm it's tracking.
- If recognition loses you (heavy ad-libbing, noise), it automatically widens
  its search and re-locks the moment you read a full phrase from the script.
- **Auto mode** is a classic constant-speed teleprompter as a fallback —
  adjust speed in settings.
- **Privacy:** scripts are stored in the browser's local storage on the device
  where you typed them — they are never uploaded anywhere. Anyone else opening
  the app URL gets their own fresh, empty copy and can never see your scripts.
  (This also means scripts don't sync between your own devices.) To back a
  script up, copy the text out of the editor.

## Development

```
npm test          # run the voice-matching engine tests (Node 18+)
python3 server.py 8347        # serve manually
```

Plain HTML/CSS/JS, no build step, no dependencies:

- `js/matcher.js` — fuzzy voice-to-script alignment engine
- `js/speech.js` — Web Speech API wrapper (auto-restarts Chrome sessions)
- `js/prompter.js` — presentation view: scrolling, countdown, timer, settings
- `js/store.js` — script library + settings in localStorage
- `js/app.js` — routing, library, editor
- `sw.js` + `manifest.webmanifest` — installable-app (PWA) support

The fluted-glass backdrop is pure CSS (`body::before` in `css/style.css`) —
tweak the two radial-gradient glows there to change its colors, or set a
`background-image` on it to use a photo instead.
