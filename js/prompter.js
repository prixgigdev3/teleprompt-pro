// The presentation view: renders the script, follows the reader's voice (or
// auto-scrolls), and owns the countdown, timer, status bar, and settings drawer.

import { parseScript, ScriptMatcher } from './matcher.js';
import { SpeechEngine } from './speech.js';
import { saveSettings, LANGUAGES } from './store.js';

const NUDGE_WORDS = 6;

export class Prompter {
  constructor(root, { onExit, toast }) {
    this.root = root;
    this.onExit = onExit;
    this.toast = toast;

    this.$ = (sel) => root.querySelector(sel);
    this.scrollEl = this.$('#prompter-scroll');
    this.contentEl = this.$('#prompter-content');
    this.titleEl = this.$('#prompter-title');
    this.timerEl = this.$('#timer-elapsed');
    this.remainEl = this.$('#timer-remaining');
    this.statusEl = this.$('#status-pill');
    this.heardEl = this.$('#heard-words');
    this.progressEl = this.$('#progress-fill');
    this.countdownEl = this.$('#countdown-overlay');
    this.startBtn = this.$('#btn-start');
    this.drawer = this.$('#settings-drawer');

    this.bound = {
      keydown: (e) => this.onKeydown(e),
      mousemove: () => this.wakeChrome(),
      touchstart: () => this.wakeChrome(),
      wheel: () => this.onManualScroll(),
      touchmove: () => this.onManualScroll(),
    };
    this.wireControls();
  }

  open(script, settings) {
    this.script = script;
    this.settings = settings;
    this.state = 'idle'; // idle | countdown | running | paused | done
    this.mode = 'voice'; // voice | auto
    this.manualUntil = 0;
    this.startedAt = null;
    this.elapsedBase = 0;
    this.paceLog = [];
    this.countdownAbort = null;

    const { paragraphs, tokens } = parseScript(script.text);
    this.tokens = tokens;
    this.matcher = new ScriptMatcher(tokens);
    this.engine = new SpeechEngine({
      lang: this.settings.lang,
      onWords: (words) => this.onWords(words),
      onState: (s) => this.onEngineState(s),
      onError: (e) => this.onEngineError(e),
    });

    this.titleEl.textContent = script.title || 'Untitled script';
    this.renderScript(paragraphs);
    this.applySettings();
    this.updateModeUI();
    this.setStatus('idle');
    this.heardEl.textContent = '';
    this.updateProgress();
    this.updateStartBtn();
    this.timerEl.textContent = '0:00';
    this.remainEl.textContent = '';
    this.drawer.classList.remove('open');
    this.syncSettingsInputs();

    this.scrollEl.scrollTop = 0;
    this.scrollTarget = 0;

    document.addEventListener('keydown', this.bound.keydown);
    this.root.addEventListener('mousemove', this.bound.mousemove);
    this.root.addEventListener('touchstart', this.bound.touchstart, { passive: true });
    this.scrollEl.addEventListener('wheel', this.bound.wheel, { passive: true });
    this.scrollEl.addEventListener('touchmove', this.bound.touchmove, { passive: true });
    this.wokeAt = 0;
    this.wakeChrome();

    this.lastFrame = performance.now();
    this.rafId = requestAnimationFrame((t) => this.frame(t));
    this.timerInterval = setInterval(() => this.updateTimer(), 500);

    if (!SpeechEngine.supported) {
      this.mode = 'auto';
      this.updateModeUI();
      this.toast('Voice tracking is not supported in this browser — using auto-scroll. For voice mode, use Google Chrome.', 6000);
    }
  }

  close() {
    this.abortCountdown();
    if (this.engine) this.engine.stop();
    cancelAnimationFrame(this.rafId);
    clearInterval(this.timerInterval);
    clearTimeout(this.chromeTimer);
    document.removeEventListener('keydown', this.bound.keydown);
    this.root.removeEventListener('mousemove', this.bound.mousemove);
    this.root.removeEventListener('touchstart', this.bound.touchstart);
    this.scrollEl.removeEventListener('wheel', this.bound.wheel);
    this.scrollEl.removeEventListener('touchmove', this.bound.touchmove);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  // ---------- rendering ----------

  renderScript(paragraphs) {
    this.contentEl.textContent = '';
    this.wordEls = new Map();
    const frag = document.createDocumentFragment();
    for (const words of paragraphs) {
      const p = document.createElement('p');
      if (!words.length) {
        p.className = 'blank';
      } else {
        for (const { raw, index } of words) {
          const span = document.createElement('span');
          span.className = 'w';
          span.textContent = raw;
          if (index >= 0) {
            span.dataset.i = index;
            this.wordEls.set(index, span);
          }
          p.appendChild(span);
          p.appendChild(document.createTextNode(' '));
        }
      }
      frag.appendChild(p);
    }
    this.contentEl.appendChild(frag);
    this.renderedPos = -1;
  }

  applySettings() {
    const s = this.settings;
    const st = this.root.style;
    st.setProperty('--tp-font-size', s.fontSize + 'px');
    st.setProperty('--tp-line-height', s.lineHeight);
    st.setProperty('--tp-margin', s.marginPct + '%');
    st.setProperty('--tp-eye-line', s.eyeLinePct + '%');
    st.setProperty('--tp-eye-line-vh', s.eyeLinePct + 'vh');
    st.setProperty('--tp-align', s.align || 'left');
    st.setProperty('--tp-text', s.textColor);
    st.setProperty('--tp-bg', s.bgColor);
    st.setProperty('--tp-read', s.readColor);
    st.setProperty('--tp-highlight', s.highlightColor);
    this.scrollEl.classList.toggle('mirrored', !!s.mirror);
    this.heardEl.style.display = s.showHeard ? '' : 'none';
    if (this.engine && this.engine.lang !== s.lang) this.engine.setLanguage(s.lang);
    saveSettings(s);
    // Re-anchor the scroll target since layout metrics may have changed.
    if (this.matcher.position >= 0) this.retarget(this.matcher.position);
  }

  setPosition(pos, { jump = false } = {}) {
    pos = Math.max(-1, Math.min(pos, this.tokens.length - 1));
    const old = this.renderedPos;
    if (pos > old) {
      for (let i = old + 1; i <= pos; i++) this.wordEls.get(i)?.classList.add('read');
    } else if (pos < old) {
      for (let i = pos + 1; i <= old; i++) this.wordEls.get(i)?.classList.remove('read');
    }
    this.wordEls.get(old)?.classList.remove('current');
    if (pos >= 0) this.wordEls.get(pos)?.classList.add('current');
    this.renderedPos = pos;
    this.matcher.position = pos;
    this.retarget(pos);
    if (jump) this.scrollEl.scrollTop = this.scrollTarget;
    this.updateProgress();
  }

  retarget(pos) {
    const el = this.wordEls.get(pos);
    if (!el) {
      this.scrollTarget = 0;
      return;
    }
    const eyeY = this.scrollEl.clientHeight * (this.settings.eyeLinePct / 100);
    const max = this.scrollEl.scrollHeight - this.scrollEl.clientHeight;
    this.scrollTarget = Math.max(0, Math.min(max, el.offsetTop - eyeY));
  }

  updateProgress() {
    const n = this.tokens.length;
    const pct = n ? ((this.renderedPos + 1) / n) * 100 : 0;
    this.progressEl.style.width = pct + '%';
  }

  // ---------- animation ----------

  frame(t) {
    const dt = Math.min((t - this.lastFrame) / 1000, 0.1);
    this.lastFrame = t;
    if (this.state === 'running') {
      if (this.mode === 'auto') {
        const max = this.scrollEl.scrollHeight - this.scrollEl.clientHeight;
        const next = Math.min(max, this.scrollEl.scrollTop + this.settings.autoSpeed * dt);
        this.scrollEl.scrollTop = next;
        this.progressEl.style.width = (max > 0 ? (next / max) * 100 : 0) + '%';
        if (next >= max && max > 0) this.finish();
      } else if (performance.now() > this.manualUntil) {
        const cur = this.scrollEl.scrollTop;
        const diff = this.scrollTarget - cur;
        if (Math.abs(diff) > 0.5) {
          this.scrollEl.scrollTop = cur + diff * Math.min(1, dt * 3.5);
        }
      }
    }
    this.rafId = requestAnimationFrame((tt) => this.frame(tt));
  }

  onManualScroll() {
    // Let the reader wheel/drag freely; voice tracking resumes shortly after.
    this.manualUntil = performance.now() + 2500;
    this.wakeChrome();
  }

  // ---------- start / pause / finish ----------

  async toggleStart() {
    if (this.state === 'countdown') {
      this.abortCountdown();
      return;
    }
    if (this.state === 'running') {
      this.pause();
      return;
    }
    if (this.state === 'done') {
      this.restart();
      return;
    }
    // idle or paused → start
    const fresh = this.state === 'idle';
    if (fresh && this.settings.countdown > 0) {
      const ok = await this.runCountdown(this.settings.countdown);
      if (!ok) return;
    }
    this.state = 'running';
    this.startedAt = performance.now();
    if (fresh) this.elapsedBase = 0;
    if (this.mode === 'voice') this.engine.start();
    else this.setStatus('auto');
    this.updateStartBtn();
    this.wakeChrome();
  }

  pause() {
    if (this.state !== 'running') return;
    this.elapsedBase += (performance.now() - this.startedAt) / 1000;
    this.startedAt = null;
    this.state = 'paused';
    this.engine.stop();
    // Pause gaps would deflate the rolling WPM; start the estimate fresh.
    this.paceLog = [];
    this.remainEl.textContent = '';
    this.setStatus('paused');
    this.updateStartBtn();
  }

  restart() {
    this.abortCountdown();
    this.engine.stop();
    this.state = 'idle';
    this.elapsedBase = 0;
    this.startedAt = null;
    this.paceLog = [];
    this.matcher.reset(-1);
    this.setPosition(-1, { jump: true });
    this.scrollEl.scrollTop = 0;
    this.scrollTarget = 0;
    this.timerEl.textContent = '0:00';
    this.remainEl.textContent = '';
    this.setStatus('idle');
    this.updateStartBtn();
  }

  finish() {
    if (this.state === 'done') return;
    if (this.startedAt !== null) {
      this.elapsedBase += (performance.now() - this.startedAt) / 1000;
      this.startedAt = null;
    }
    this.state = 'done';
    this.engine.stop();
    this.setStatus('done');
    this.updateStartBtn();
  }

  runCountdown(seconds) {
    this.state = 'countdown';
    this.updateStartBtn();
    this.countdownEl.classList.add('visible');
    return new Promise((resolve) => {
      let n = seconds;
      const tick = () => {
        if (!this.countdownAbort) return; // aborted
        if (n <= 0) {
          this.countdownEl.classList.remove('visible');
          this.countdownAbort = null;
          resolve(true);
          return;
        }
        this.countdownEl.textContent = n;
        n--;
        this.countdownTimer = setTimeout(tick, 1000);
      };
      this.countdownAbort = () => {
        clearTimeout(this.countdownTimer);
        this.countdownEl.classList.remove('visible');
        this.countdownAbort = null;
        this.state = 'idle';
        this.updateStartBtn();
        resolve(false);
      };
      tick();
    });
  }

  abortCountdown() {
    if (this.countdownAbort) this.countdownAbort();
  }

  // ---------- voice events ----------

  onWords(words) {
    if (this.state !== 'running' || this.mode !== 'voice') return;
    if (this.settings.showHeard) {
      this.heardEl.textContent = words.slice(-7).join(' ');
    }
    const res = this.matcher.feed(words);
    if (res.moved) {
      this.setPosition(res.position);
      this.paceLog.push({ t: performance.now(), pos: res.position });
      if (res.position >= this.tokens.length - 1) this.finish();
    }
  }

  onEngineState(s) {
    if (this.state !== 'running' || this.mode !== 'voice') return;
    if (s === 'listening') this.setStatus('listening');
    // 'restarting' blips are routine; keep showing the listening pill.
  }

  onEngineError(err) {
    if (err === 'mic-denied') {
      this.pause();
      this.toast('Microphone access was blocked. Click the mic icon in the address bar, allow access, then press Start again.', 8000);
    } else if (err === 'no-mic') {
      this.pause();
      this.toast('No microphone detected. Connect or select a mic, then press Start again.', 8000);
    } else if (err === 'bad-lang') {
      this.pause();
      this.toast('Speech recognition does not support the selected language. Pick another one in ⚙ settings.', 8000);
    } else if (err === 'network') {
      this.toast('Speech service unreachable — voice tracking needs an internet connection in Chrome.', 6000);
    } else if (err === 'unstable') {
      this.toast('Voice recognition keeps disconnecting. Check your internet connection, or switch to Auto mode.', 6000);
    } else if (err === 'unsupported') {
      this.mode = 'auto';
      this.updateModeUI();
      this.toast('Voice tracking is not supported in this browser — switched to auto-scroll.', 6000);
    }
  }

  setStatus(s) {
    const labels = {
      idle: 'Ready',
      listening: 'Listening',
      paused: 'Paused',
      auto: 'Auto-scroll',
      done: 'Finished',
    };
    this.statusEl.textContent = labels[s] || s;
    this.statusEl.dataset.state = s;
  }

  // ---------- timer ----------

  elapsedSeconds() {
    let e = this.elapsedBase;
    if (this.startedAt !== null) e += (performance.now() - this.startedAt) / 1000;
    return e;
  }

  updateTimer() {
    const e = this.elapsedSeconds();
    this.timerEl.textContent = fmtTime(e);
    if (this.state !== 'running' || this.mode !== 'voice') return;

    // Rolling words-per-minute over the last 45 seconds of progress.
    const now = performance.now();
    this.paceLog = this.paceLog.filter((p) => now - p.t < 45000);
    if (this.paceLog.length >= 2) {
      const first = this.paceLog[0];
      const last = this.paceLog[this.paceLog.length - 1];
      const mins = (last.t - first.t) / 60000;
      const wpm = mins > 0.05 ? (last.pos - first.pos) / mins : 0;
      if (wpm > 20) {
        const left = this.tokens.length - 1 - this.renderedPos;
        this.remainEl.textContent = '-' + fmtTime((left / wpm) * 60);
        return;
      }
    }
    this.remainEl.textContent = '';
  }

  // ---------- controls ----------

  wireControls() {
    this.$('#btn-back').addEventListener('click', () => this.onExit());
    this.$('#btn-font-down').addEventListener('click', () => this.adjustFont(-4));
    this.$('#btn-font-up').addEventListener('click', () => this.adjustFont(4));
    this.startBtn.addEventListener('click', () => this.toggleStart());
    this.$('#btn-restart').addEventListener('click', () => this.restart());
    this.$('#btn-fullscreen').addEventListener('click', () => this.toggleFullscreen());
    this.$('#btn-settings').addEventListener('click', () => this.drawer.classList.toggle('open'));
    this.$('#btn-drawer-close').addEventListener('click', () => this.drawer.classList.remove('open'));

    for (const btn of this.root.querySelectorAll('[data-mode]')) {
      btn.addEventListener('click', () => this.setMode(btn.dataset.mode));
    }

    this.contentEl.addEventListener('click', (e) => {
      // A tap that woke the hidden controls must not also jump the position.
      if (this.wokeAt && performance.now() - this.wokeAt < 600) {
        this.wokeAt = 0;
        return;
      }
      const span = e.target.closest('.w[data-i]');
      if (!span) return;
      this.manualJump(Number(span.dataset.i));
    });

    this.wireSettingsInputs();
  }

  // Move the reading position by user action (click, nudge, mode re-anchor).
  // The live recognizer's transcript still ends at the OLD position, so flush
  // it — otherwise the next result event re-anchors right back.
  manualJump(pos) {
    this.matcher.reset(pos);
    this.setPosition(pos);
    this.paceLog = [];
    this.remainEl.textContent = '';
    this.engine.flush();
  }

  adjustFont(delta) {
    this.settings.fontSize = Math.max(20, Math.min(120, this.settings.fontSize + delta));
    this.applySettings();
    this.syncSettingsInputs();
  }

  setMode(mode) {
    if (mode === this.mode) return;
    if (mode === 'voice' && !SpeechEngine.supported) {
      this.toast('Voice tracking needs Google Chrome (or another browser with speech recognition).', 5000);
      return;
    }
    this.mode = mode;
    if (this.state === 'running') {
      if (mode === 'auto') {
        this.engine.stop();
        this.setStatus('auto');
      } else {
        // Re-anchor voice position to wherever the screen currently is.
        this.syncPositionToScroll();
        this.engine.start();
      }
    }
    this.updateModeUI();
  }

  // Find the word nearest the eye-line and make it the current position.
  syncPositionToScroll() {
    const eyeY = this.scrollEl.scrollTop + this.scrollEl.clientHeight * (this.settings.eyeLinePct / 100);
    let bestI = -1;
    let bestD = Infinity;
    for (const [i, el] of this.wordEls) {
      const d = Math.abs(el.offsetTop - eyeY);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    if (bestI >= 0) this.manualJump(bestI);
  }

  updateModeUI() {
    for (const btn of this.root.querySelectorAll('[data-mode]')) {
      btn.classList.toggle('active', btn.dataset.mode === this.mode);
    }
    this.root.classList.toggle('auto-mode', this.mode === 'auto');
  }

  updateStartBtn() {
    const labels = {
      idle: 'Start',
      countdown: 'Cancel',
      running: 'Pause',
      paused: 'Resume',
      done: 'Start over',
    };
    this.startBtn.textContent = labels[this.state];
    this.startBtn.classList.toggle('primary', this.state !== 'running');
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  onKeydown(e) {
    if (e.target.matches('input, textarea, select')) return;
    // Leave browser shortcuts (Cmd+R, Ctrl+F, Alt+arrows, ...) alone.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        this.toggleStart();
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.nudge(NUDGE_WORDS);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.nudge(-NUDGE_WORDS);
        break;
      case '+':
      case '=':
        this.adjustFont(4);
        break;
      case '-':
        this.adjustFont(-4);
        break;
      case 'f':
      case 'F':
        this.toggleFullscreen();
        break;
      case 'm':
      case 'M':
        this.setMode(this.mode === 'voice' ? 'auto' : 'voice');
        break;
      case 'r':
      case 'R':
        this.restart();
        break;
      case 's':
      case 'S':
        this.drawer.classList.toggle('open');
        break;
      case 'Escape':
        if (this.drawer.classList.contains('open')) this.drawer.classList.remove('open');
        else if (!document.fullscreenElement) this.onExit();
        break;
    }
  }

  nudge(words) {
    if (this.mode === 'auto') {
      this.scrollEl.scrollTop += Math.sign(words) * this.scrollEl.clientHeight * 0.15;
      return;
    }
    const pos = Math.max(0, Math.min(this.tokens.length - 1, this.renderedPos + words));
    this.manualJump(pos);
  }

  wakeChrome() {
    // Remember when a wake actually revealed hidden controls, so the tap
    // that caused it can be treated as wake-only (not a word jump).
    if (this.root.classList.contains('chrome-hidden')) {
      this.wokeAt = performance.now();
    }
    this.root.classList.remove('chrome-hidden');
    clearTimeout(this.chromeTimer);
    this.chromeTimer = setTimeout(() => {
      if (this.state === 'running' && !this.drawer.classList.contains('open')) {
        this.root.classList.add('chrome-hidden');
      }
    }, 3500);
  }

  // ---------- settings drawer ----------

  wireSettingsInputs() {
    const langSel = this.$('#set-lang');
    langSel.textContent = '';
    for (const [code, label] of LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = label;
      langSel.appendChild(opt);
    }

    const bind = (id, key, { numeric = true, checkbox = false } = {}) => {
      const el = this.$(id);
      el.addEventListener('input', () => {
        this.settings[key] = checkbox ? el.checked : numeric ? Number(el.value) : el.value;
        this.applySettings();
        const out = this.$(id + '-val');
        if (out) out.textContent = el.value;
      });
    };

    bind('#set-font', 'fontSize');
    bind('#set-lineheight', 'lineHeight');
    bind('#set-margin', 'marginPct');
    bind('#set-eyeline', 'eyeLinePct');
    bind('#set-speed', 'autoSpeed');
    bind('#set-countdown', 'countdown');
    bind('#set-text-color', 'textColor', { numeric: false });
    bind('#set-bg-color', 'bgColor', { numeric: false });
    bind('#set-highlight-color', 'highlightColor', { numeric: false });
    bind('#set-lang', 'lang', { numeric: false });
    bind('#set-mirror', 'mirror', { checkbox: true });
    bind('#set-heard', 'showHeard', { checkbox: true });

    for (const btn of this.root.querySelectorAll('#set-align [data-align]')) {
      btn.addEventListener('click', () => {
        this.settings.align = btn.dataset.align;
        this.applySettings();
        this.syncAlignButtons();
      });
    }
  }

  syncAlignButtons() {
    for (const btn of this.root.querySelectorAll('#set-align [data-align]')) {
      btn.classList.toggle('active', btn.dataset.align === (this.settings.align || 'left'));
    }
  }

  syncSettingsInputs() {
    const s = this.settings;
    const setVal = (id, v) => {
      const el = this.$(id);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v;
      const out = this.$(id + '-val');
      if (out) out.textContent = v;
    };
    setVal('#set-font', s.fontSize);
    setVal('#set-lineheight', s.lineHeight);
    setVal('#set-margin', s.marginPct);
    setVal('#set-eyeline', s.eyeLinePct);
    setVal('#set-speed', s.autoSpeed);
    setVal('#set-countdown', s.countdown);
    setVal('#set-text-color', s.textColor);
    setVal('#set-bg-color', s.bgColor);
    setVal('#set-highlight-color', s.highlightColor);
    setVal('#set-lang', s.lang);
    setVal('#set-mirror', s.mirror);
    setVal('#set-heard', s.showHeard);
    this.syncAlignButtons();
  }
}

export function fmtTime(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m + ':' + String(s).padStart(2, '0');
}
