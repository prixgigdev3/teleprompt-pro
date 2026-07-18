// App shell: hash routing between the library, editor, and prompter views.

import {
  ensureSampleScript, listScripts, getScript, saveScript, deleteScript,
  newScript, loadSettings, listSessions, getSession, deleteSession,
} from './store.js';
import { parseScript } from './matcher.js';
import { Prompter, fmtTime } from './prompter.js';
import { analyzeSession, buildCoachPrompt, aggregateInsights } from './analysis.js';

const views = {
  library: document.getElementById('view-library'),
  editor: document.getElementById('view-editor'),
  prompter: document.getElementById('view-prompter'),
  report: document.getElementById('view-report'),
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
  const reportList = hash.match(/^#\/reports\/(.+)$/);
  const reportOne = hash.match(/^#\/report\/(.+)$/);
  const insights = hash.match(/^#\/insights$/);

  if (insights) {
    showView('report');
    renderInsights();
  } else if (reportList) {
    showView('report');
    renderSessionList(reportList[1]);
  } else if (reportOne) {
    const session = getSession(reportOne[1]);
    if (!session) return navigate('#/');
    showView('report');
    renderReport(session);
  } else if (present) {
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

    const sessionCount = listSessions(script.id).length;
    let reportsBtn = null;
    if (sessionCount > 0) {
      reportsBtn = document.createElement('button');
      reportsBtn.className = 'btn';
      reportsBtn.textContent = `📊 ${sessionCount}`;
      reportsBtn.title = 'Session reports';
      reportsBtn.addEventListener('click', () => navigate('#/reports/' + script.id));
    }

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

    actions.append(presentBtn, editBtn);
    if (reportsBtn) actions.append(reportsBtn);
    actions.append(delBtn);
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

document.getElementById('btn-insights').addEventListener('click', () => navigate('#/insights'));

// ---------- session reports ----------

const reportTitle = document.getElementById('report-title');
const reportSubtitle = document.getElementById('report-subtitle');
const reportBody = document.getElementById('report-body');
const copyCoachBtn = document.getElementById('btn-copy-coach');
let reportBackTarget = '#/';
let coachPromptText = '';

document.getElementById('btn-report-back').addEventListener('click', () => navigate(reportBackTarget));
copyCoachBtn.addEventListener('click', async () => {
  if (!coachPromptText) return;
  try {
    await navigator.clipboard.writeText(coachPromptText);
    toast('Coaching prompt copied — paste it into Claude for the qualitative analysis.');
  } catch {
    toast('Could not copy automatically — your browser blocked clipboard access.');
  }
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtDur(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

// Cross-session patterns: the spots you stop at and skip most, across all takes.
function renderInsights() {
  const sessions = listSessions();
  const { totalSessions, scripts } = aggregateInsights(sessions);
  reportBackTarget = '#/';
  coachPromptText = '';
  copyCoachBtn.hidden = true;
  reportTitle.textContent = 'Insights across your recordings';
  reportSubtitle.textContent = totalSessions
    ? `${totalSessions} recorded session${totalSessions > 1 ? 's' : ''} across ${scripts.length} script${scripts.length > 1 ? 's' : ''}`
    : 'No recorded sessions yet';
  reportBody.textContent = '';

  if (!totalSessions) {
    const empty = el('div', 'card report-section');
    empty.append(
      el('h3', '', 'Nothing to analyze yet'),
      el('p', 'meta', 'Present a script in voice mode for ~30 seconds or more, and your takes show up here. Then this page ranks the phrases you stop at and skip most across all of them.'),
    );
    reportBody.append(empty);
    return;
  }

  const recur = (row) => row.takes > 1
    ? `in ${row.takes} of your takes (${row.times}×)`
    : `once`;

  for (const s of scripts) {
    const head = el('div', 'insight-script-head');
    head.append(el('h2', '', s.scriptTitle));
    head.append(el('span', 'meta', `${s.takes} take${s.takes > 1 ? 's' : ''}`));
    reportBody.append(head);

    // Stops
    const stopCard = el('div', 'card report-section');
    stopCard.append(
      el('h3', '', '⏸ Where you stop the most'),
      el('p', 'meta', 'longest pauses, grouped by the script line you stopped on'),
    );
    if (s.mostStoppedAt.length) {
      const list = el('ol', 'report-list');
      for (const r of s.mostStoppedAt) {
        const li = el('li');
        li.append(el('em', '', `“${r.context}”`));
        const meta = el('span', 'meta',
          ` — ${recur(r)}, ~${r.avgSec.toFixed(1)}s${r.maxSec > r.avgSec + 0.5 ? ` (up to ${r.maxSec.toFixed(1)}s)` : ''}`);
        li.append(meta);
        list.append(li);
      }
      stopCard.append(list);
    } else {
      stopCard.append(el('p', 'meta', 'No notable pauses — clean delivery. 🎉'));
    }
    reportBody.append(stopCard);

    // Skips
    const skipCard = el('div', 'card report-section');
    skipCard.append(
      el('h3', '', '⏭ What you skip the most'),
      el('p', 'meta', 'script passages the prompter never heard you read'),
    );
    if (s.mostSkipped.length) {
      const list = el('ol', 'report-list');
      for (const r of s.mostSkipped) {
        const li = el('li');
        li.append(el('em', '', `“${r.context}”`));
        li.append(el('span', 'meta', ` — ${recur(r)}, ~${r.words} words`));
        list.append(li);
      }
      skipCard.append(list);
    } else {
      skipCard.append(el('p', 'meta', 'You covered the whole script every time. 🎯'));
    }
    reportBody.append(skipCard);
  }
}

function renderSessionList(scriptId) {
  const sessions = listSessions(scriptId);
  const script = getScript(scriptId);
  reportBackTarget = '#/';
  coachPromptText = '';
  copyCoachBtn.hidden = true;
  reportTitle.textContent = script ? (script.title || 'Untitled script') : 'Sessions';
  reportSubtitle.textContent = sessions.length
    ? `${sessions.length} recorded session${sessions.length > 1 ? 's' : ''}`
    : 'No recorded sessions yet — present this script in voice mode for at least a minute.';
  reportBody.textContent = '';
  const grid = el('div', 'card-grid');
  for (const s of sessions) {
    const card = el('div', 'card');
    card.append(
      el('h3', '', new Date(s.startedAt).toLocaleString()),
      el('p', 'meta', `${fmtDur(s.elapsedSec)} · ${s.words || 0} words spoken · reached ${Math.round(((s.finalPos + 1) / (s.tokensTotal || 1)) * 100)}% of script`),
    );
    const actions = el('div', 'card-actions');
    const open = el('button', 'btn primary', 'Open report');
    open.addEventListener('click', () => navigate('#/report/' + s.id));
    const del = el('button', 'btn danger', 'Delete');
    del.addEventListener('click', () => {
      if (confirm('Delete this session report?')) {
        deleteSession(s.id);
        renderSessionList(scriptId);
      }
    });
    actions.append(open, del);
    card.append(actions);
    grid.append(card);
  }
  reportBody.append(grid);
}

function renderReport(session) {
  const scriptText = session.scriptText ?? getScript(session.scriptId)?.text ?? '';
  const report = analyzeSession(session, scriptText);
  reportBackTarget = '#/reports/' + session.scriptId;
  coachPromptText = buildCoachPrompt(session, scriptText, report);
  copyCoachBtn.hidden = false;

  reportTitle.textContent = session.scriptTitle || 'Session report';
  reportSubtitle.textContent =
    `${new Date(session.startedAt).toLocaleString()} · ${fmtDur(report.durationSec)}`;
  reportBody.textContent = '';

  // headline stats
  const chips = el('div', 'stat-row');
  const stat = (value, label) => {
    const c = el('div', 'stat-chip');
    c.append(el('div', 'stat-value', String(value)), el('div', 'stat-label', label));
    return c;
  };
  chips.append(
    stat(fmtDur(report.durationSec), 'duration'),
    stat(report.totalSpoken, 'words spoken'),
    stat(report.avgWpm ?? '—', 'avg wpm'),
    stat(report.coverage + '%', 'script covered'),
    stat(report.pauseCount, 'pauses'),
    stat(report.fumbles.length, 'fumbles'),
    stat(report.offScript, 'off-script moments'),
  );
  reportBody.append(chips);

  const section = (title, hint) => {
    const card = el('div', 'card report-section');
    card.append(el('h3', '', title));
    if (hint) card.append(el('p', 'meta', hint));
    reportBody.append(card);
    return card;
  };

  // pace sparkline
  if (report.pace.length > 1) {
    const card = section('Pace, minute by minute', 'words read from the script per minute');
    const max = Math.max(...report.pace, 1);
    const w = 16;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${report.pace.length * w} 64`);
    svg.setAttribute('class', 'pace-chart');
    report.pace.forEach((v, i) => {
      const h = Math.max(2, (v / max) * 56);
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', i * w + 2);
      rect.setAttribute('y', 60 - h);
      rect.setAttribute('width', w - 4);
      rect.setAttribute('height', h);
      rect.setAttribute('rx', 2);
      rect.setAttribute('class', 'pace-bar');
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      t.textContent = `min ${i + 1}: ${v} words`;
      rect.append(t);
      svg.append(rect);
    });
    card.append(svg);
  }

  if (report.topPauses.length) {
    const card = section('Longest pauses', 'where you stopped — silence over 2.5 seconds');
    const list = el('ul', 'report-list');
    for (const p of report.topPauses) {
      const li = el('li');
      li.append(
        el('strong', '', (p.durMs / 1000).toFixed(1) + 's'),
        el('span', 'meta', ` at ${fmtTime(p.t / 1000)} — `),
        el('em', '', `“${p.context}”`),
      );
      list.append(li);
    }
    card.append(list);
  }

  if (report.fumbles.length) {
    const card = section('Fumble hotspots', 'places you went back or retook a line');
    const list = el('ul', 'report-list');
    for (const f of report.fumbles) {
      const li = el('li');
      li.append(
        el('em', '', `“${f.context}”`),
        el('span', 'meta', ` — ${f.count} ${f.count > 1 ? 'rewinds' : 'rewind'}${f.retake ? ' (retake)' : ''} around ${fmtTime(f.t / 1000)}`),
      );
      list.append(li);
    }
    card.append(list);
  }

  if (report.fillers.length || report.overused.length) {
    const card = section('Words you lean on', 'spoken far more than the script asks for');
    const wrap = el('div', 'chip-wrap');
    for (const w2 of [...report.fillers, ...report.overused.filter(
      (o) => !report.fillers.some((f) => f.word === o.word))]) {
      wrap.append(el('span', 'word-chip', `${w2.word} ×${w2.spoken}`));
    }
    card.append(wrap);
  }

  if (report.skipped.length) {
    const card = section('Skipped passages', 'script text the prompter never heard you read');
    const list = el('ul', 'report-list');
    for (const s of report.skipped) {
      list.append(el('li', '', `“${s.context}” (${s.words} words)`));
    }
    card.append(list);
  }

  if (!report.topPauses.length && !report.fumbles.length &&
      !report.fillers.length && !report.overused.length && !report.skipped.length) {
    section('Clean take 🎉', 'No long pauses, fumbles, or crutch words detected. Copy the AI coaching prompt for deeper qualitative feedback.');
  }

  const hint = el('p', 'meta coach-hint',
    '✦ “Copy AI coaching prompt” bundles your script, what you actually said, and these stats into a prompt for Claude — it answers the qualitative questions: which sentences didn’t land, why the fumbles happened, and what to change for the next take.');
  reportBody.append(hint);
}

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
