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
  readColor: '#5a5a60',
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
