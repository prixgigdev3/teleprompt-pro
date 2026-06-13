// Script library + settings, persisted in localStorage.

const SCRIPTS_KEY = 'tp_scripts_v1';
const SETTINGS_KEY = 'tp_settings_v1';

export const DEFAULT_SETTINGS = {
  fontSize: 52,        // px
  lineHeight: 1.6,
  marginPct: 12,       // side margins, % of viewport width
  eyeLinePct: 35,      // eye-line marker, % from top
  align: 'left',       // left | center | right
  textColor: '#f4f2ec',
  bgColor: '#0a0a0c',
  readMix: 55,         // % visibility of already-read words (vs background)
  highlightColor: '#ffd166',
  mirror: false,
  lang: 'en-US',
  countdown: 3,        // seconds
  autoSpeed: 55,       // px/sec for classic auto-scroll
  showHeard: true,     // show recognized words in the status bar
};

export const LANGUAGES = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['en-ZA', 'English (South Africa)'],
  ['en-AU', 'English (Australia)'],
  ['af-ZA', 'Afrikaans'],
  ['nl-NL', 'Dutch'],
  ['fr-FR', 'French'],
  ['de-DE', 'German'],
  ['es-ES', 'Spanish (Spain)'],
  ['es-MX', 'Spanish (Mexico)'],
  ['pt-BR', 'Portuguese (Brazil)'],
  ['it-IT', 'Italian'],
];

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...read(SETTINGS_KEY, {}) };
}

export function saveSettings(settings) {
  write(SETTINGS_KEY, settings);
}

export function listScripts() {
  const scripts = read(SCRIPTS_KEY, []);
  return Array.isArray(scripts) ? scripts : [];
}

export function getScript(id) {
  return listScripts().find((s) => s.id === id) || null;
}

export function saveScript(script) {
  const scripts = listScripts();
  const i = scripts.findIndex((s) => s.id === script.id);
  script.updatedAt = Date.now();
  if (i >= 0) scripts[i] = script;
  else scripts.unshift(script);
  return write(SCRIPTS_KEY, scripts);
}

export function deleteScript(id) {
  return write(SCRIPTS_KEY, listScripts().filter((s) => s.id !== id));
}

export function newScript(title = '', text = '') {
  return {
    id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    title,
    text,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ---------- recorded sessions (for the post-read analysis report) ----------

const SESSIONS_KEY = 'tp_sessions_v1';
const MAX_SESSIONS = 20;

export function listSessions(scriptId = null) {
  const sessions = read(SESSIONS_KEY, []);
  const all = Array.isArray(sessions) ? sessions : [];
  return scriptId === null ? all : all.filter((s) => s.scriptId === scriptId);
}

export function getSession(id) {
  return listSessions().find((s) => s.id === id) || null;
}

export function saveSession(session) {
  const sessions = listSessions();
  // Upsert: a take is checkpointed repeatedly under one id, so replace any
  // existing record rather than accumulating duplicates.
  const existing = sessions.findIndex((s) => s.id === session.id);
  if (existing >= 0) sessions.splice(existing, 1);
  sessions.unshift(session);
  while (sessions.length > MAX_SESSIONS) sessions.pop();
  if (write(SESSIONS_KEY, sessions)) return true;
  // Storage is tight: drop the oldest sessions until the new one fits.
  while (sessions.length > 1) {
    sessions.pop();
    if (write(SESSIONS_KEY, sessions)) return true;
  }
  return false;
}

export function deleteSession(id) {
  return write(SESSIONS_KEY, listSessions().filter((s) => s.id !== id));
}

const SAMPLE_TEXT = `Welcome to Teleprompt Pro, your voice-powered teleprompter.

Just start reading this script out loud, and watch the text scroll along with you. There is no need to set a speed or touch anything while you present.

If you skip a sentence, improvise for a moment, or stumble over a few words, don't worry. The prompter waits for you, and the moment you return to the script, it picks up right where you are and keeps going.

You can adjust the font size, colors, and margins from the settings panel, switch to a classic auto-scroll mode, or nudge the position with the arrow keys at any time.

When you are ready, create your own script from the library, press present, and enjoy hands-free reading. Good luck with your recording!`;

export function ensureSampleScript() {
  let existing;
  try {
    existing = localStorage.getItem(SCRIPTS_KEY);
  } catch {
    return; // storage blocked entirely — boot proceeds with an empty library
  }
  if (existing !== null) return;
  const sample = newScript('Demo: try me first', SAMPLE_TEXT);
  saveScript(sample);
}
