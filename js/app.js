// App shell: hash routing between the library, editor, and prompter views.

import {
  ensureSampleScript, listScripts, getScript, saveScript, deleteScript,
  newScript, loadSettings,
} from './store.js';
import { parseScript } from './matcher.js';
import { Prompter, fmtTime } from './prompter.js';

const views = {
  library: document.getElementById('view-library'),
  editor: document.getElementById('view-editor'),
  prompter: document.getElementById('view-prompter'),
};

const settings = loadSettings();
let prompter = null;
let editorScript = null;
let editorSaveTimer = null;

// ---------- toast ----------

const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg, ms = 4000) {
  toastEl.textContent = msg;
  toastEl.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('visible'), ms);
}

// ---------- routing ----------

function navigate(hash) {
  location.hash = hash;
}

function route() {
  const hash = location.hash || '#/';
  if (prompter) {
    prompter.close();
    prompter = null;
  }
  flushEditorSave();

  const present = hash.match(/^#\/present\/(.+)$/);
  const edit = hash.match(/^#\/edit\/(.+)$/);

  if (present) {
    const script = getScript(present[1]);
    if (!script) return navigate('#/');
    showView('prompter');
    prompter = new PrompterSingleton();
    prompter.open(script, settings);
  } else if (edit) {
    const script = getScript(edit[1]);
    if (!script) return navigate('#/');
    showView('editor');
    openEditor(script);
  } else {
    showView('library');
    renderLibrary();
  }
}

function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    el.hidden = key !== name;
  }
}

// The prompter wires its DOM listeners once; reuse a single instance.
let prompterInstance = null;
function PrompterSingleton() {
  if (!prompterInstance) {
    prompterInstance = new Prompter(views.prompter, {
      onExit: () => navigate('#/'),
      toast,
    });
  }
  return prompterInstance;
}

// ---------- library ----------

function scriptStats(text) {
  const { tokens } = parseScript(text);
  const words = tokens.length;
  const est = fmtTime((words / 150) * 60); // ~150 wpm speaking pace
  return { words, est };
}

function renderLibrary() {
  const listEl = document.getElementById('script-list');
  const emptyEl = document.getElementById('library-empty');
  listEl.textContent = '';
  const scripts = listScripts();
  emptyEl.hidden = scripts.length > 0;

  for (const script of scripts) {
    const { words, est } = scriptStats(script.text);
    const card = document.createElement('div');
    card.className = 'card';

    const title = document.createElement('h3');
    title.textContent = script.title || 'Untitled script';

    const snippet = document.createElement('p');
    snippet.className = 'snippet';
    snippet.textContent = script.text.slice(0, 160);

    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = `${words} words · ~${est} · updated ${new Date(script.updatedAt).toLocaleDateString()}`;

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const presentBtn = document.createElement('button');
    presentBtn.className = 'btn primary';
    presentBtn.textContent = '▶ Present';
    presentBtn.addEventListener('click', () => navigate('#/present/' + script.id));

    const editBtn = document.createElement('button');
    editBtn.className = 'btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => navigate('#/edit/' + script.id));

    const delBtn = document.createElement('button');
    delBtn.className = 'btn danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => {
      if (confirm(`Delete "${script.title || 'Untitled script'}"? This cannot be undone.`)) {
        if (!deleteScript(script.id)) {
          toast('Could not delete — browser storage is blocked.', 6000);
        }
        renderLibrary();
      }
    });

    actions.append(presentBtn, editBtn, delBtn);
    card.append(title, snippet, meta, actions);
    listEl.appendChild(card);
  }
}

document.getElementById('btn-new-script').addEventListener('click', () => {
  const script = newScript('', '');
  if (!saveScript(script)) {
    toast('Could not create a script — browser storage is full or blocked.', 6000);
    return;
  }
  navigate('#/edit/' + script.id);
});

// ---------- editor ----------

const titleInput = document.getElementById('editor-title');
const textInput = document.getElementById('editor-text');
const statsEl = document.getElementById('editor-stats');

function openEditor(script) {
  editorScript = script;
  titleInput.value = script.title;
  textInput.value = script.text;
  updateEditorStats();
  if (!script.title) titleInput.focus();
  else textInput.focus();
}

function updateEditorStats() {
  const { words, est } = scriptStats(textInput.value);
  statsEl.textContent = `${words} words · ~${est} at 150 wpm`;
}

function scheduleEditorSave() {
  clearTimeout(editorSaveTimer);
  editorSaveTimer = setTimeout(flushEditorSave, 400);
}

function flushEditorSave() {
  clearTimeout(editorSaveTimer);
  editorSaveTimer = null;
  if (!editorScript) return;
  if (editorScript.title !== titleInput.value || editorScript.text !== textInput.value) {
    // Commit to the in-memory script only after the write succeeds, so a
    // failed save stays dirty and every later flush retries (and re-warns).
    const candidate = { ...editorScript, title: titleInput.value, text: textInput.value };
    if (saveScript(candidate)) {
      editorScript = candidate;
    } else {
      toast('Could not save — browser storage is full or blocked.', 6000);
    }
  }
}

titleInput.addEventListener('input', () => scheduleEditorSave());
textInput.addEventListener('input', () => {
  updateEditorStats();
  scheduleEditorSave();
});

document.getElementById('btn-editor-back').addEventListener('click', () => navigate('#/'));
document.getElementById('btn-editor-present').addEventListener('click', () => {
  flushEditorSave();
  if (!textInput.value.trim()) {
    toast('Add some text to the script first.');
    return;
  }
  navigate('#/present/' + editorScript.id);
});

window.addEventListener('beforeunload', flushEditorSave);

// ---------- boot ----------

ensureSampleScript();
window.addEventListener('hashchange', route);
route();

// Installable-app support (Add to Dock / Home Screen).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {
    // Offline support is a nice-to-have; the app works without it.
  });
}

if (location.protocol === 'file:') {
  toast('Open this app via the "Start Teleprompt Pro.command" launcher — the microphone does not work from a file:// page.', 10000);
}
