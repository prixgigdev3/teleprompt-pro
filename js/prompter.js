// The presentation view: renders the script, follows the reader's voice (or
// auto-scrolls), and owns the countdown, timer, status bar, and settings drawer.

import { parseScript, ScriptMatcher } from './matcher.js';
import { SpeechEngine } from './speech.js';
import { saveSettings, saveSession, LANGUAGES } from './store.js';

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
      // Persist the take if the tab is backgrounded or closed mid-session.
      pagehide: () => this.recPersist(),
      visibility: () => { if (document.visibilityState === 'hidden') this.recPersist(); },
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
    this.sentenceStarts = computeSentenceStarts(paragraphs);
    this.matcher = new ScriptMatcher(tokens);
    this.engine = new SpeechEngine({
      lang: this.settings.lang,
      onWords: (words) => this.onWords(words),
      onFinalWords: (words) => this.onFinalWords(words),
      onState: (s) => this.onEngineState(s),
      onError: (e) => this.onEngineError(e),
    });

    // Session recorder + adaptive-scroll state.
    this.rec = null;
    this.lastSessionId = null;
    this.isLost = false;
    this.scrollRate = 80;   // px/s, learned from the reader's pace
    this.snapNext = false;  // skip the speed cap right after a manual jump
    this.lastMoveT = 0;
    this.lastMoveTarget = 0;
    this.$('#btn-report').hidden = true;

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
    window.addEventListener('pagehide', this.bound.pagehide);
    document.addEventListener('visibilitychange', this.bound.visibility);
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
    this.recPersist();
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
    window.removeEventListener('pagehide', this.bound.pagehide);
    document.removeEventListener('visibilitychange', this.bound.visibility);
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
    const mix = s.readMix ?? 55;
    st.setProperty('--tp-read', `color-mix(in srgb, ${s.textColor} ${mix}%, ${s.bgColor})`);
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

  // ---------- session recorder ----------

  recStart() {
    this.rec = {
      id: 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      scriptId: this.script.id,
      scriptTitle: this.script.title || 'Untitled script',
      scriptText: this.script.text,
      startedAt: Date.now(),
      t0: performance.now(),
      heard: [],     // {t, w} newly-finalized words per recognition event
      activity: [],  // timestamps of any recognition activity (pause detection)
      trace: [],     // {t, pos} accepted position moves
      marks: [],     // {t, type, ...} retakes, jumps, lost/relock, pause/resume
      persisted: false,
      persistFailed: false,
      lastPersistAt: 0,
    };
    this.lastSessionId = null;
    this.$('#btn-report').hidden = true;
  }

  recT() {
    return this.rec ? Math.round(performance.now() - this.rec.t0) : 0;
  }

  recMark(type, extra = {}) {
    if (this.rec) this.rec.marks.push({ t: this.recT(), type, ...extra });
  }

  // Checkpoint the current take to storage. Called continuously (autosave),
  // on pause/finish/exit, AND when the tab is hidden or closing — so a session
  // is never lost just because the reader closed the tab or switched apps.
  // Uses an upsert keyed on rec.id, so repeated calls update one record.
  recPersist() {
    const rec = this.rec;
    if (!rec) return;
    const elapsed = (performance.now() - rec.t0) / 1000;
    if (elapsed < 30 || rec.trace.length < 5) return; // not a real take yet
    rec.lastPersistAt = performance.now();
    const session = {
      id: rec.id,
      scriptId: rec.scriptId,
      scriptTitle: rec.scriptTitle,
      scriptText: rec.scriptText,
      startedAt: rec.startedAt,
      elapsedSec: Math.round(elapsed),
      tokensTotal: this.tokens.length,
      finalPos: this.renderedPos,
      words: rec.heard.reduce((n, h) => n + h.w.split(/\s+/).length, 0),
      heard: rec.heard,
      activity: rec.activity,
      trace: rec.trace,
      marks: rec.marks,
    };
    if (saveSession(session)) {
      const firstTime = !rec.persisted;
      rec.persisted = true;
      rec.persistFailed = false;
      this.lastSessionId = session.id;
      this.$('#btn-report').hidden = false;
      if (firstTime) {
        this.toast('Recording your session — press 📊 anytime for your delivery report.', 4500);
      }
    } else if (!rec.persistFailed) {
      rec.persistFailed = true;
      this.toast('Could not save this session — browser storage may be full. Free up space to keep your report.', 7000);
    }
  }

  onFinalWords(words) {
    if (this.rec && this.state === 'running') {
      this.rec.heard.push({ t: this.recT(), w: words.join(' ') });
    }
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
          // Proportional catch-up, capped to the reader's measured pace so a
          // burst of matched words glides instead of skipping. Manual jumps
          // (snapNext) bypass the cap once.
          const cap = this.snapNext
            ? 5000
            : Math.min(900, Math.max(50, this.scrollRate * 2.5));
          let v = diff * 3;
          if (v > cap) v = cap;
          else if (v < -cap) v = -cap;
          this.scrollEl.scrollTop = cur + v * dt;
          if (this.snapNext && Math.abs(diff) < 24) this.snapNext = false;
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
    if (this.mode === 'voice') {
      if (fresh || !this.rec) this.recStart();
      else this.recMark('resume');
      this.engine.start();
    } else {
      this.setStatus('auto');
    }
    this.updateStartBtn();
    this.wakeChrome();
  }

  pause() {
    if (this.state !== 'running') return;
    this.elapsedBase += (performance.now() - this.startedAt) / 1000;
    this.startedAt = null;
    this.state = 'paused';
    this.engine.stop();
    this.recMark('pause');
    // Pause gaps would deflate the rolling WPM; start the estimate fresh.
    this.paceLog = [];
    this.remainEl.textContent = '';
    this.setStatus('paused');
    this.updateStartBtn();
  }

  restart() {
    this.recPersist(); // a restart ends the current take; keep its data
    this.rec = null;
    this.abortCountdown();
    this.engine.stop();
    this.isLost = false;
    this.lastMoveT = 0;
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
    this.recMark('finish');
    this.recPersist();
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
    const now = performance.now();
    if (this.rec) {
      const t = this.recT();
      const acts = this.rec.activity;
      if (!acts.length || t - acts[acts.length - 1] >= 400) acts.push(t);
    }

    const res = this.matcher.feed(words);

    // Off-script sensing: after a few unmatched feeds the prompter visibly
    // waits; the moment a solid phrase matches again it re-locks.
    if (res.lost && !this.isLost) {
      this.isLost = true;
      this.setStatus('waiting');
      this.recMark('lost');
    } else if (!res.lost && this.isLost && res.moved) {
      this.isLost = false;
      this.setStatus('listening');
      this.recMark('relock');
    }

    if (res.moved) {
      // Learn the reader's scroll pace (px/s) from voice-driven moves only.
      const prevTarget = this.scrollTarget;
      this.setPosition(res.position);
      if (this.lastMoveT) {
        const dtm = (now - this.lastMoveT) / 1000;
        const dpx = this.scrollTarget - this.lastMoveTarget;
        if (dtm > 0.05 && dtm < 5 && dpx > 0) {
          this.scrollRate = 0.75 * this.scrollRate + 0.25 * Math.min(1200, dpx / dtm);
        }
      }
      this.lastMoveT = now;
      this.lastMoveTarget = this.scrollTarget;

      this.paceLog.push({ t: now, pos: res.position });
      if (this.rec) this.rec.trace.push({ t: this.recT(), pos: res.position });
      if (res.position >= this.tokens.length - 1) this.finish();
    }
  }

  onEngineState(s) {
    if (this.state !== 'running' || this.mode !== 'voice') return;
    // Engine restarts are routine; don't flip an off-script "waiting" pill.
    if (s === 'listening') this.setStatus(this.isLost ? 'waiting' : 'listening');
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
      waiting: 'Off-script — waiting',
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

    // Autosave the take every ~15s so a crash or hard tab-close keeps it.
    if (this.rec && performance.now() - (this.rec.lastPersistAt || 0) > 15000) {
      this.recPersist();
    }

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
    this.$('#btn-retake').addEventListener('click', () => this.retake());
    this.$('#btn-report').addEventListener('click', () => {
      if (this.lastSessionId) location.hash = '#/report/' + this.lastSessionId;
    });
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
  manualJump(pos, markType = 'jump') {
    const from = this.renderedPos;
    this.matcher.reset(pos);
    this.setPosition(pos);
    this.paceLog = [];
    this.remainEl.textContent = '';
    this.snapNext = true;   // jump the scroll there at full speed
    this.lastMoveT = 0;     // don't let the jump poison the pace estimate
    this.isLost = false;
    if (this.state === 'running' && this.mode === 'voice') this.setStatus('listening');
    this.recMark(markType, { from, to: pos });
    this.engine.flush();
  }

  // Jump back to the start of the current sentence (or the previous one when
  // already at a sentence start) so a line can be re-taken cleanly.
  retake() {
    if (!this.tokens.length) return;
    const pos = Math.max(0, this.renderedPos);
    let starts = this.sentenceStarts;
    let s = 0;
    for (const idx of starts) {
      if (idx <= pos) s = idx;
      else break;
    }
    if (pos - s < 3) {
      // Already at the top of this sentence — go one sentence further back.
      let prev = 0;
      for (const idx of starts) {
        if (idx < s) prev = idx;
        else break;
      }
      s = prev;
    }
    this.manualJump(s - 1, 'retake');
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
      case 'b':
      case 'B':
      case 'Backspace':
        e.preventDefault();
        this.retake();
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
    bind('#set-readmix', 'readMix');
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
    setVal('#set-readmix', s.readMix ?? 55);
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

// Token indices that begin a sentence: first token overall, first token of a
// paragraph, or any token following one whose raw text ends a sentence.
function computeSentenceStarts(paragraphs) {
  const starts = [];
  let expectStart = true;
  for (const words of paragraphs) {
    if (words.length) expectStart = true; // paragraph break starts a sentence
    for (const w of words) {
      if (w.index < 0) continue;
      if (expectStart) starts.push(w.index);
      expectStart = /[.!?…]["')\]]*$/.test(w.raw);
    }
  }
  return starts.length ? starts : [0];
}

export function fmtTime(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m + ':' + String(s).padStart(2, '0');
}
