// Thin wrapper around the Web Speech API (SpeechRecognition).
//
// Chrome ends continuous sessions after silence or ~a few minutes, so the
// engine auto-restarts while active. Each result event reports the full word
// stream of the current session; the matcher only ever looks at the tail, so
// session resets are harmless.

export class SpeechEngine {
  constructor({ lang = 'en-US', onWords, onFinalWords, onState, onError } = {}) {
    this.lang = lang;
    this.onWords = onWords || (() => {});
    // Called with only the NEWLY-finalized words of the current session —
    // suitable for building a running transcript (session analytics).
    this.onFinalWords = onFinalWords || (() => {});
    this.onState = onState || (() => {});
    this.onError = onError || (() => {});
    this.active = false;
    this.rec = null;
    this._restartTimer = null;
    this._recentRestarts = 0;
    this._sessionStartedAt = 0;
  }

  static get supported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  setLanguage(lang) {
    this.lang = lang;
    this.flush();
  }

  // Drop the current session (and its accumulated transcript) and start a
  // fresh one. Used after manual position jumps so stale recognized words
  // cannot re-anchor the matcher at the old spot, and on language changes.
  flush() {
    if (!this.active) return;
    clearTimeout(this._restartTimer);
    this._teardown();
    this._spin();
  }

  start() {
    if (this.active) return;
    this.active = true;
    this._recentRestarts = 0;
    this._spin();
  }

  stop() {
    this.active = false;
    clearTimeout(this._restartTimer);
    this._teardown();
    this.onState('stopped');
  }

  _teardown() {
    if (!this.rec) return;
    const rec = this.rec;
    this.rec = null;
    rec.onresult = rec.onend = rec.onerror = rec.onstart = null;
    try { rec.abort(); } catch { /* already stopped */ }
  }

  _spin() {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) {
      this.active = false;
      this.onError('unsupported');
      return;
    }
    this._teardown(); // never leak a live recognizer with handlers attached
    const rec = new Ctor();
    this.rec = rec;
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      this._sessionStartedAt = Date.now();
      this.onState('listening');
    };

    let reportedFinals = 0; // per-session: how many final words already emitted
    rec.onresult = (event) => {
      this._recentRestarts = 0;
      const words = [];
      const finals = [];
      for (let i = 0; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript.trim();
        if (!transcript) continue;
        const parts = transcript.split(/\s+/);
        words.push(...parts);
        if (event.results[i].isFinal) finals.push(...parts);
      }
      if (words.length) this.onWords(words);
      if (finals.length > reportedFinals) {
        const fresh = finals.slice(reportedFinals);
        reportedFinals = finals.length;
        this.onFinalWords(fresh);
      }
    };

    rec.onerror = (event) => {
      const err = event.error;
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        this.active = false;
        clearTimeout(this._restartTimer);
        this.onState('stopped');
        this.onError('mic-denied');
      } else if (err === 'audio-capture' || err === 'language-not-supported') {
        // Permanent conditions — retrying forever just burns CPU while the
        // pill claims to be listening.
        this.active = false;
        clearTimeout(this._restartTimer);
        this.onState('stopped');
        this.onError(err === 'audio-capture' ? 'no-mic' : 'bad-lang');
      } else if (err === 'network') {
        this.onError('network');
        // onend fires next and schedules a retry.
      }
      // 'no-speech' and 'aborted' are routine; onend handles them.
    };

    rec.onend = () => {
      if (!this.active) return;
      this.onState('restarting');
      // Back off only when sessions are dying immediately and repeatedly
      // (e.g. no internet for Chrome's recognition service). Sessions that
      // lived a while ended for normal reasons like silence — restart fast.
      const lived = Date.now() - this._sessionStartedAt;
      if (lived < 3000) this._recentRestarts++;
      else this._recentRestarts = 0;
      const delay = this._recentRestarts > 5 ? 2000 : 200;
      if (this._recentRestarts > 0 && this._recentRestarts % 12 === 0) {
        this.onError('unstable');
      }
      clearTimeout(this._restartTimer);
      this._restartTimer = setTimeout(() => {
        if (this.active) this._spin();
      }, delay);
    };

    try {
      rec.start();
    } catch {
      // start() can throw if called while a previous instance is closing.
      clearTimeout(this._restartTimer);
      this._restartTimer = setTimeout(() => {
        if (this.active) this._spin();
      }, 300);
    }
  }
}
