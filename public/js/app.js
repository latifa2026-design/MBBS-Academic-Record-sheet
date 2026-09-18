'use strict';

/* ============================================================
   MBBS ACADEMIC RECORD SHEET — frontend logic
   Talks to the Node.js server (server.js), which proxies to
   Google Apps Script → Google Sheets (the database).
   ============================================================ */

/* ---------- Course structure (keep in sync with Code.gs) ---------- */
const ITEM_MASTER = [
  { term: 1, card: 1, subject: 'Cellular Physiology', count: 5 },
  { term: 1, card: 1, subject: 'Blood Physiology', count: 5 },
  { term: 1, card: 2, subject: 'Cardiovascular System', count: 6 },
  { term: 2, card: 3, subject: 'Respiratory System', count: 5 },
  { term: 2, card: 4, subject: 'GIT & Renal System', count: 7 },
  { term: 3, card: 5, subject: 'Endocrinology & Reproductive System', count: 9 },
  { term: 3, card: 6, subject: 'Nervous System', count: 10 },
];
const CARD_SUBJECTS = {
  1: 'Cellular & Blood Physiology',
  2: 'Cardiovascular System',
  3: 'Respiratory System',
  4: 'GIT & Renal System',
  5: 'Endocrinology & Reproductive System',
  6: 'Nervous System',
};
const CARD_TERM = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3 };
const TERM_NAMES = { 1: '1st Term', 2: '2nd Term', 3: '3rd Term' };
/* Re-take exams reuse the TermFinals sheet with term numbers 11/12/13
   (= re-take of 1st/2nd/3rd term) so they never collide with the
   regular term 1/2/3 upserts on the backend. */
const RETAKE_TERM = { 1: 11, 2: 12, 3: 13 };
const RETAKE_NAMES = { 11: '1st Term Re-take', 12: '2nd Term Re-take', 13: '3rd Term Re-take' };
const termDisplayName = (t) => TERM_NAMES[t] || RETAKE_NAMES[t] || ('Term ' + t);

/* Marking scheme — edit to match your institution */
const TERM_COMPONENTS = { written: 100, oral: 100, practical: 100 };  // full marks
const TERM_FULL = TERM_COMPONENTS.written + TERM_COMPONENTS.oral + TERM_COMPONENTS.practical;
const PASS_PERCENT = 60;
const CARD_FULL_MARKS = 100;
const ATTENDANCE_WARN = 75;

/* ---------- State ---------- */
const state = {
  students: [],
  pending: [],
  cardFinals: [],
  termFinals: [],
  attendance: [],
  selected: null,          // currently selected student ID
  pendingFilter: 'All',
  studentYearFilter: 'All', // Students tab: All | 1st Year | 2nd Year
  editingStudent: null,    // student ID being edited in the form
};

/* ---------- Tiny DOM / format helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const pctOf = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
const gradeOf = (p) => p >= 80 ? 'A+' : p >= 70 ? 'A' : p >= 60 ? 'A-' : p >= 50 ? 'B' : p >= 40 ? 'C' : 'F';
const todayStr = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const selStudent = () => state.students.find((s) => String(s.ID) === String(state.selected));
const emptyState = (msg) => '<div class="empty">' + esc(msg) + '</div>';
const noRow = (n) => '<tr><td colspan="' + n + '" class="empty">No records yet.</td></tr>';

function setDbStatus(cls, text) {
  const el = $('#dbStatus');
  el.className = 'status-dot ' + cls;
  el.textContent = '\u25CF ' + text;
}

let toastTimer = null;
function toast(msg, type) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + (type || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

/* ---------- In-page confirm dialog ---------- */
/* Native window.confirm() is silently ignored by some environments (embedded
   browsers such as VS Code "Simple Browser", sandboxed iframes, or after the
   user ticks "prevent this page from creating additional dialogs"). This
   promise-based in-page dialog always works, so Delete can never become a
   silent no-op. */
let confirmResolve = null;

function showConfirm(message, confirmLabel) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $('#confirmMsg').textContent = message;
    $('#confirmOk').textContent = confirmLabel || 'Delete';
    $('#confirmModal').classList.remove('hidden');
    $('#confirmOk').focus();
  });
}

function closeConfirm(result) {
  if (!confirmResolve) return;                 // already closed — ignore extra events
  const resolve = confirmResolve;
  confirmResolve = null;
  $('#confirmModal').classList.add('hidden');
  resolve(result);
}

/* ============================================================
   AUTH — sign-in gate
   Credentials are validated by the Node server (/api/login);
   the session token is kept per browser tab (sessionStorage)
   and sent with every API call as the X-Auth-Token header.
   ============================================================ */
const AUTH_TOKEN_KEY = 'mbrs.auth.token';
const auth = { token: null };
try { auth.token = sessionStorage.getItem(AUTH_TOKEN_KEY) || null; } catch (e) { /* storage blocked */ }

function authHeaders() {
  return auth.token ? { 'X-Auth-Token': auth.token } : {};
}

function showLogin(msg) {
  auth.token = null;
  try { sessionStorage.removeItem(AUTH_TOKEN_KEY); } catch (e) { /* private mode */ }
  const err = $('#loginError');
  if (msg) { err.textContent = msg; err.classList.remove('hidden'); }
  else err.classList.add('hidden');
  $('#loginGate').classList.remove('hidden');
  setTimeout(() => { try { $('#loginId').focus(); } catch (e) { /* ignore */ } }, 60);
}

function enterApp() {
  $('#loginGate').classList.add('hidden');
  loadAll();
}

async function onLoginSubmit(e) {
  e.preventDefault();
  const id = $('#loginId').value.trim();
  const password = $('#loginPassword').value;
  if (!id || !password) return showLogin('Please enter both ID and password.');
  const btn = $('#loginSubmit');
  btn.disabled = true;
  btn.textContent = 'Signing in\u2026';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, password: password }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Sign-in failed.');
    auth.token = json.data.token;
    try { sessionStorage.setItem(AUTH_TOKEN_KEY, auth.token); } catch (err2) { /* ignore */ }
    $('#loginPassword').value = '';
    enterApp();
  } catch (err) {
    showLogin(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
}

async function onLogout() {
  try { await fetch('/api/logout', { method: 'POST', headers: authHeaders() }); } catch (e) { /* ignore */ }
  showLogin('You have been signed out.');
}

/* The server answered 401 — the session expired or the server restarted. */
function handleAuthError() {
  showLogin('Session expired \u2014 please sign in again.');
}

function initAuth() {
  $('#loginForm').addEventListener('submit', onLoginSubmit);
  $('#btnLogout').addEventListener('click', onLogout);
  if (auth.token) enterApp();
  else showLogin();
}

/* ---------- API ---------- */
async function apiGet(path) {
  /* _ts cache-buster: never let a browser/proxy cache answer with a stale
     list — a deleted row must disappear immediately. The Node server strips
     the query string before routing, so this is invisible to the API. */
  const res = await fetch(path + (path.indexOf('?') >= 0 ? '&' : '?') + '_ts=' + Date.now(), { headers: authHeaders() });
  const json = await res.json();
  if (res.status === 401) {
    handleAuthError();
    const err = new Error(json.error || 'Please sign in to continue.');
    err.authRequired = true;
    throw err;
  }
  if (!json.ok) throw new Error(json.error || 'Request failed');
  return json.data;
}

async function apiPost(path, data) {
  const res = await fetch(path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
    body: JSON.stringify(data || {}),
  });
  const json = await res.json();
  if (res.status === 401) {
    handleAuthError();
    const err = new Error(json.error || 'Please sign in to continue.');
    err.authRequired = true;
    throw err;
  }
  if (!json.ok) throw new Error(json.error || 'Request failed');
  return json.data;
}

/* ---------- Load everything from the server ---------- */
/* Fetch one endpoint, retrying transient backend hiccups (Google Apps Script
   occasionally answers with an error when calls arrive in rapid succession). */
async function apiGetRetry(path, tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 800 * i));
    try { return await apiGet(path); } catch (err) {
      if (err && err.authRequired) throw err;   // 401 — do not retry, show the gate
      lastErr = err;
    }
  }
  throw lastErr;
}

async function loadAll() {
  setDbStatus('connecting', 'connecting\u2026');
  try {
    const [students, pending, cardFinals, termFinals, attendance] = await Promise.all([
      apiGetRetry('/api/students'),
      apiGetRetry('/api/pending'),
      apiGetRetry('/api/cardfinals'),
      apiGetRetry('/api/termfinals'),
      apiGetRetry('/api/attendance'),
    ]);
    state.students = students || [];
    state.pending = pending || [];
    state.cardFinals = cardFinals || [];
    state.termFinals = termFinals || [];
    state.attendance = attendance || [];
    if (!state.selected || !state.students.some((s) => String(s.ID) === String(state.selected))) {
      state.selected = state.students.length ? String(state.students[0].ID) : null;
    }
    setDbStatus('online', 'connected to Google Sheet');
    renderAll();
  } catch (err) {
    if (err && err.authRequired) return;   // login gate already shown
    setDbStatus('offline', 'offline');
    renderAll();
    toast('\u26A0 ' + err.message, 'error');
  }
}

/* ---------- Tabs & selects ---------- */
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
}

function studentOption(s) {
  return '<option value="' + esc(s.ID) + '">' + esc(s.Roll) + ' \u2014 ' + esc(s.Name) + ' (' + esc(s.Year) + ')</option>';
}

function populateSelects() {
  const opts = state.students.map(studentOption).join('');
  ['#pendingStudent', '#cardStudent', '#termStudent', '#retakeStudent', '#attStudent'].forEach((sel) => {
    const el = $(sel);
    el.innerHTML = opts || '<option value="">(no students yet)</option>';
    el.value = state.selected || '';
  });
}

function renderAll() {
  populateSelects();
  renderDashboard();
  renderStudents();
  renderPending();
  renderCardFinal();
  renderTermFinal();
  renderRetakeFinal();
  renderAttendance();
}

/* ============================================================
   STUDENTS
   ============================================================ */

function studentPendingCount(id) {
  return state.pending.filter((p) => String(p.StudentID) === String(id) && (p.Status || 'Pending') === 'Pending').length;
}

function renderStudents() {
  const q = ($('#studentSearch').value || '').trim().toLowerCase();
  const yearFilter = state.studentYearFilter || 'All';
  const rows = state.students.filter((s) => {
    /* Year filter — tolerant match ("1st Year", "1st year", "Year 1", …) */
    if (yearFilter !== 'All') {
      const y = String(s.Year || '').toLowerCase();
      if (yearFilter === '1st Year' && y.indexOf('1st') < 0) return false;
      if (yearFilter === '2nd Year' && y.indexOf('2nd') < 0) return false;
    }
    /* Search matches roll, name, year AND session (previously roll+name only,
       so searching e.g. "1st" or a session looked like a dead search bar). */
    if (q) {
      const hay = [s.Roll, s.Name, s.Year, s.Session]
        .map((v) => String(v == null ? '' : v).toLowerCase()).join(' ');
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });

  $('#studentsTable tbody').innerHTML = rows.map((s) => {
    const pend = studentPendingCount(s.ID);
    return '<tr>' +
      '<td>' + esc(s.Roll) + '</td>' +
      '<td>' + esc(s.Name) + '</td>' +
      '<td>' + esc(s.Year) + '</td>' +
      '<td>' + (pend > 0 ? '<span class="badge warn">' + pend + ' pending</span>' : '<span class="badge ok">none</span>') + '</td>' +
      '<td>' + esc(s.Session || '\u2014') + '</td>' +
      '<td>' + (pend > 0 ? '<span class="badge warn">' + pend + ' pending</span>' : '<span class="badge ok">all done</span>') + '</td>' +
      '<td>' + esc(s.Status || 'Active') + '</td>' +
      '<td>' +
        '<button class="btn sm primary" data-act="open" data-id="' + esc(s.ID) + '">Items</button> ' +
        '<button class="btn sm" data-act="edit" data-id="' + esc(s.ID) + '">Edit</button> ' +
        '<button class="btn sm danger" data-act="del" data-id="' + esc(s.ID) + '">Del</button>' +
      '</td></tr>';
  }).join('') || '<tr><td colspan="8" class="empty">' +
    (state.students.length
      ? 'No students match the current search / year filter.'
      : 'No students yet \u2014 add the first one above.') +
    '</td></tr>';

  const count = $('#studentCount');
  if (count) {
    count.textContent = rows.length === state.students.length
      ? '(' + rows.length + ')'
      : '(' + rows.length + ' of ' + state.students.length + ')';
  }

  $$('#studentsTable [data-act]').forEach((b) => b.addEventListener('click', onStudentAction));
}

async function onStudentAction(e) {
  const act = e.currentTarget.dataset.act;
  const id = e.currentTarget.dataset.id;
  const s = state.students.find((x) => String(x.ID) === String(id));
  if (!s) return;
  if (act === 'open') {
    state.selected = String(id);
    renderAll();
    switchTab('pending');
  } else if (act === 'edit') {
    state.editingStudent = String(id);
    $('#studentFormTitle').textContent = '\u270F Edit student \u2014 ' + s.Roll;
    $('#stRoll').value = s.Roll;
    $('#stName').value = s.Name;
    $('#stYear').value = s.Year || '1st Year';
    $('#stSession').value = s.Session || '';
    $('#studentSubmit').textContent = '\uD83D\uDCBE Save changes';
    $('#studentCancel').classList.remove('hidden');
    $('#stRoll').focus();
  } else if (act === 'del') {
    const ok = await showConfirm(
      'Delete ' + s.Roll + ' \u2014 ' + s.Name + '?\nAll their pending items, card/term results and attendance will also be deleted from the Google Sheet database.'
    );
    if (!ok) return;
    try {
      await apiPost('/api/students/delete', { id });
      /* Remove the rows locally right away and re-render, so the student
         disappears instantly even if the follow-up refresh hiccups. */
      state.students = state.students.filter((x) => String(x.ID) !== String(id));
      state.pending = state.pending.filter((x) => String(x.StudentID) !== String(id));
      state.cardFinals = state.cardFinals.filter((x) => String(x.StudentID) !== String(id));
      state.termFinals = state.termFinals.filter((x) => String(x.StudentID) !== String(id));
      state.attendance = state.attendance.filter((x) => String(x.StudentID) !== String(id));
      if (state.selected && String(state.selected) === String(id)) {
        state.selected = state.students.length ? String(state.students[0].ID) : null;
      }
      if (state.editingStudent && String(state.editingStudent) === String(id)) resetStudentForm();
      renderAll();
      toast('\uD83D\uDDD1 Student deleted from Google Sheet', 'success');
      loadAll();
    } catch (err) { toast(err.message, 'error'); }
  }
}

async function onStudentSubmit(e) {
  e.preventDefault();
  const data = {
    roll: $('#stRoll').value.trim(),
    name: $('#stName').value.trim(),
    year: $('#stYear').value,
    session: $('#stSession').value.trim(),
  };
  if (!data.roll || !data.name) { toast('Roll and name are required', 'error'); return; }
  try {
    if (state.editingStudent) {
      await apiPost('/api/students/update', Object.assign({ id: state.editingStudent }, data));
      toast('\uD83D\uDCBE Student updated', 'success');
    } else {
      await apiPost('/api/students', data);
      toast('\u2705 Student added \u2014 47 card items seeded', 'success');
    }
    resetStudentForm();
    loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

function resetStudentForm() {
  state.editingStudent = null;
  $('#studentForm').reset();
  $('#studentFormTitle').textContent = '\u2795 Add student';
  $('#studentSubmit').textContent = '+ Add student';
  $('#studentCancel').classList.add('hidden');
}

/* ============================================================
   PENDING ITEMS
   ============================================================ */

function chipHtml(it) {
  const st = it.Status || 'Pending';
  const hidden = state.pendingFilter !== 'All' && state.pendingFilter !== st;
  const title = it.ItemLabel + ' \u2014 ' + st + (it.DoneDate ? ' on ' + it.DoneDate : '');
  return '<button class="chip ' + st.toLowerCase() + (hidden ? ' dim' : '') + '" data-id="' + esc(it.ID) + '" title="' + esc(title) + '">' +
    '<span class="chip-no">' + esc(it.ItemNo) + '</span>Item ' + esc(it.ItemNo) +
    '<span class="chip-check' + (st === 'Done' ? ' checked' : '') + '" data-check="' + esc(it.ID) + '" ' +
      'title="' + (st === 'Done' ? 'Done \u2014 click to uncheck' : 'Check when done') + '">' +
      (st === 'Done' ? '\u2713' : '') +
    '</span>' +
    '</button>';
}

function renderPending() {
  const s = selStudent();
  const wrap = $('#pendingCards');
  if (!s) {
    wrap.innerHTML = emptyState('No students yet. Add students in the Students tab first.');
    $('#pendingSummary').innerHTML = '';
    return;
  }
  const items = state.pending
    .filter((p) => String(p.StudentID) === String(state.selected))
    .sort((a, b) => (a.Term - b.Term) || (a.Card - b.Card) || (a.ItemNo - b.ItemNo));

  const done = items.filter((i) => i.Status === 'Done').length;
  const ex = items.filter((i) => i.Status === 'Exempted').length;
  const pen = items.length - done - ex;
  const complete = pctOf(done + ex, items.length);

  $('#pendingSummary').innerHTML =
    '<div class="sum-line"><strong>' + esc(s.Roll) + ' \u2014 ' + esc(s.Name) + '</strong> (' + esc(s.Year) + ')</div>' +
    '<div class="progress"><div class="progress-fill" style="width:' + complete + '%"></div></div>' +
    '<div class="sum-stats">' +
      '<span class="badge ok">Done ' + done + '</span>' +
      '<span class="badge warn">Pending ' + pen + '</span>' +
      '<span class="badge info">Exempted ' + ex + '</span>' +
      '<span class="badge">Total ' + items.length + '</span>' +
      '<span class="badge ' + (complete >= 100 ? 'ok' : '') + '">Completion ' + complete + '%</span>' +
    '</div>';

  if (!items.length) {
    wrap.innerHTML = emptyState('No pending items seeded for this student yet. Use \u201CRe-seed missing items\u201D above.');
    return;
  }

  let html = '';
  [1, 2, 3].forEach((t) => {
    const tItems = items.filter((i) => Number(i.Term) === t);
    if (!tItems.length) return;
    html += '<div class="term-head"><h3>' + TERM_NAMES[t] + '</h3></div>';
    const cards = [...new Set(tItems.map((i) => Number(i.Card)))].sort((a, b) => a - b);
    cards.forEach((c) => {
      const cItems = tItems.filter((i) => Number(i.Card) === c);
      const subjects = [...new Set(cItems.map((i) => i.Subject))];
      subjects.forEach((sub) => {
        const gItems = cItems.filter((i) => i.Subject === sub);
        const gDone = gItems.filter((i) => i.Status === 'Done').length;
        html += '<div class="card-block">' +
          '<div class="card-block-head"><strong>Card ' + c + '</strong><span>\u00B7 ' + esc(sub) + '</span>' +
          '<span class="mini">' + gDone + '/' + gItems.length + ' done</span></div>' +
          '<div class="chip-row">' + gItems.map(chipHtml).join('') + '</div>' +
          '</div>';
      });
    });
  });
  wrap.innerHTML = html;
  $$('#pendingCards .chip').forEach((ch) => ch.addEventListener('click', onChipClick));
  $$('#pendingCards .chip-check').forEach((cb) => cb.addEventListener('click', onCheckClick));
}

/* Checkbox on the right of an item chip: tick = Done, untick = Pending. */
async function onCheckClick(e) {
  e.stopPropagation();                       // don't trigger the chip's status cycle
  const id = e.currentTarget.dataset.check;
  const it = state.pending.find((p) => String(p.ID) === String(id));
  if (!it) return;
  const next = it.Status === 'Done' ? 'Pending' : 'Done';
  try {
    await apiPost('/api/pending/update', { id, status: next });
    it.Status = next;
    it.DoneDate = next === 'Done' ? todayStr() : '';
    toast(next === 'Done' ? '\u2705 ' + it.ItemLabel + ' \u2014 done' :
          '\u21A9 ' + it.ItemLabel + ' \u2014 back to pending', 'success');
    renderPending();
    renderStudents();
    renderDashboard();
  } catch (err) { toast(err.message, 'error'); }
}

async function onChipClick(e) {
  const id = e.currentTarget.dataset.id;
  const it = state.pending.find((p) => String(p.ID) === String(id));
  if (!it) return;
  const next = it.Status === 'Pending' ? 'Done' : it.Status === 'Done' ? 'Exempted' : 'Pending';
  try {
    await apiPost('/api/pending/update', { id, status: next });
    it.Status = next;
    it.DoneDate = next === 'Done' ? todayStr() : '';
    toast(next === 'Done' ? '\u2705 ' + it.ItemLabel + ' \u2014 done' :
          next === 'Exempted' ? '\u27A4 ' + it.ItemLabel + ' \u2014 exempted' :
          '\u21A9 ' + it.ItemLabel + ' \u2014 back to pending', 'success');
    renderPending();
    renderStudents();
    renderDashboard();
  } catch (err) { toast(err.message, 'error'); }
}

async function onReseed() {
  if (!state.selected) { toast('Select a student first', 'error'); return; }
  try {
    const out = await apiPost('/api/pending/reseed', { studentId: state.selected });
    toast('\u21BA Added ' + (out.added || 0) + ' missing item rows', 'success');
    loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

/* ============================================================
   CARD FINAL
   ============================================================ */

function cardItemCount(card) {
  return ITEM_MASTER.filter((g) => g.card === Number(card)).reduce((sum, g) => sum + g.count, 0);
}

function renderCardFinal() {
  const s = selStudent();
  const grid = $('#cardFinalForms');
  if (!s) {
    grid.innerHTML = emptyState('Add a student first.');
    $('#cardFinalTable tbody').innerHTML = '';
    return;
  }
  const byCard = {};
  state.cardFinals
    .filter((r) => String(r.StudentID) === String(state.selected))
    .forEach((r) => { byCard[Number(r.Card)] = r; });

  grid.innerHTML = Object.keys(CARD_SUBJECTS).map((c) => {
    const r = byCard[c] || {};
    const badge = (r.Percentage != null && r.Percentage !== '')
      ? '<span class="badge ' + (num(r.Percentage) >= PASS_PERCENT ? 'ok' : 'warn') + '">' + esc(r.Percentage) + '% \u00B7 ' + esc(r.Grade || '') + '</span>'
      : '<span class="mini">Not recorded</span>';
    return '<div class="mini-card">' +
      '<h3>Card ' + c + ' <small>\u00B7 ' + esc(CARD_SUBJECTS[c]) + ' (' + cardItemCount(c) + ' items)</small></h3>' +
      '<div class="form-grid">' +
        '<label>Exam date<input type="date" id="cfDate' + c + '" value="' + esc(r.ExamDate || '') + '" /></label>' +
        '<label>Marks obtained<input type="number" min="0" id="cfObt' + c + '" value="' + (r.MarksObtained != null ? esc(r.MarksObtained) : '') + '" /></label>' +
        '<label>Full marks<input type="number" min="1" id="cfTot' + c + '" value="' + esc(r.MarksTotal || CARD_FULL_MARKS) + '" /></label>' +
        '<label>Remarks<input id="cfRem' + c + '" value="' + esc(r.Remarks || '') + '" /></label>' +
      '</div>' +
      '<div class="mini-card-foot">' + badge +
        '<button class="btn primary sm" data-card="' + c + '">\uD83D\uDCBE Save</button>' +
      '</div></div>';
  }).join('');

  $$('#cardFinalForms [data-card]').forEach((b) => b.addEventListener('click', saveCardFinal));

  const rows = state.cardFinals
    .filter((r) => String(r.StudentID) === String(state.selected))
    .sort((a, b) => a.Card - b.Card);
  $('#cardFinalTable tbody').innerHTML = rows.map((r) =>
    '<tr><td>Card ' + esc(r.Card) + '</td><td>' + esc(r.Subject) + '</td><td>' + esc(r.ExamDate || '\u2014') + '</td>' +
    '<td>' + esc(r.MarksObtained) + ' / ' + esc(r.MarksTotal) + '</td><td>' + esc(r.Percentage) + '%</td>' +
    '<td><span class="badge ' + (num(r.Percentage) >= PASS_PERCENT ? 'ok' : 'warn') + '">' + esc(r.Grade) + '</span></td>' +
    '<td>' + esc(r.Remarks || '') + '</td>' +
    '<td><button class="btn sm danger" data-del="' + esc(r.ID) + '">\uD83D\uDDD1</button></td></tr>'
  ).join('') || noRow(8);
  $$('#cardFinalTable [data-del]').forEach((b) =>
    b.addEventListener('click', () => deleteRecord('/api/cardfinals/delete', b.dataset.del))
  );
}

async function saveCardFinal(e) {
  const c = e.currentTarget.dataset.card;
  const obt = $('#cfObt' + c).value;
  if (obt === '') { toast('Enter marks obtained for Card ' + c, 'error'); return; }
  try {
    await apiPost('/api/cardfinals', {
      studentId: state.selected,
      card: Number(c),
      term: CARD_TERM[c],
      examDate: $('#cfDate' + c).value,
      marksObtained: Number(obt),
      marksTotal: Number($('#cfTot' + c).value) || CARD_FULL_MARKS,
      remarks: $('#cfRem' + c).value.trim(),
    });
    toast('\uD83D\uDCBE Card ' + c + ' final saved', 'success');
    loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteRecord(path, id) {
  const ok = await showConfirm('Delete this record? It will also be removed from the Google Sheet database.');
  if (!ok) return;
  try {
    await apiPost(path, { id });
    /* Update locally first so the row vanishes even if the refresh fails. */
    state.cardFinals = state.cardFinals.filter((x) => String(x.ID) !== String(id));
    state.termFinals = state.termFinals.filter((x) => String(x.ID) !== String(id));
    renderAll();
    toast('\uD83D\uDDD1 Record deleted from Google Sheet', 'success');
    loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

/* ============================================================
   TERM FINAL
   ============================================================ */

function termRecordFor(t) {
  return state.termFinals.find((r) =>
    String(r.StudentID) === String(state.selected) && Number(r.Term) === Number(t));
}

function renderTermFinal() {
  const s = selStudent();
  const grid = $('#termFinalForms');
  if (!s) {
    grid.innerHTML = emptyState('Add a student first.');
    $('#termFinalTable tbody').innerHTML = '';
    return;
  }
  grid.innerHTML = [1, 2, 3].map((t) => {
    const r = termRecordFor(t) || {};
    const badge = r.Result
      ? '<span class="badge ' + (r.Result === 'Pass' ? 'ok' : 'danger') + '">' + esc(r.Result) + ' \u00B7 ' + esc(r.Percentage) + '%</span>'
      : '<span class="mini">Not recorded</span>';
    return '<div class="mini-card">' +
      '<h3>' + TERM_NAMES[t] + ' final</h3>' +
      '<div class="form-grid">' +
        '<label>Exam date<input type="date" id="tfDate' + t + '" value="' + esc(r.ExamDate || '') + '" /></label>' +
        '<label>Written (max ' + TERM_COMPONENTS.written + ')<input type="number" min="0" id="tfW' + t + '" value="' + (r.Written != null ? esc(r.Written) : '') + '" /></label>' +
        '<label>Oral / viva (max ' + TERM_COMPONENTS.oral + ')<input type="number" min="0" id="tfO' + t + '" value="' + (r.Oral != null ? esc(r.Oral) : '') + '" /></label>' +
        '<label>Practical (max ' + TERM_COMPONENTS.practical + ')<input type="number" min="0" id="tfP' + t + '" value="' + (r.Practical != null ? esc(r.Practical) : '') + '" /></label>' +
        '<label>Remarks<input id="tfRem' + t + '" value="' + esc(r.Remarks || '') + '" /></label>' +
      '</div>' +
      '<div class="total-preview" id="tfPrev' + t + '"><span>Total: \u2014</span><span>\u2014%</span></div>' +
      '<div class="mini-card-foot">' + badge +
        '<button class="btn primary sm" data-term="' + t + '">\uD83D\uDCBE Save</button>' +
      '</div></div>';
  }).join('');

  [1, 2, 3].forEach((t) => {
    ['tfW' + t, 'tfO' + t, 'tfP' + t].forEach((id) =>
      $('#' + id).addEventListener('input', () => updateTermPreview(t)));
    updateTermPreview(t);
  });

  $$('#termFinalForms [data-term]').forEach((b) => b.addEventListener('click', saveTermFinal));

  const rows = state.termFinals
    .filter((r) => String(r.StudentID) === String(state.selected))
    .sort((a, b) => a.Term - b.Term);
  $('#termFinalTable tbody').innerHTML = rows.map((r) =>
    '<tr><td>' + esc(termDisplayName(r.Term)) + '</td><td>' + esc(r.ExamDate || '\u2014') + '</td>' +
    '<td>' + esc(r.Written) + '</td><td>' + esc(r.Oral) + '</td><td>' + esc(r.Practical) + '</td>' +
    '<td><strong>' + esc(r.Total) + '</strong> / ' + TERM_FULL + '</td><td>' + esc(r.Percentage) + '%</td>' +
    '<td><span class="badge ' + (r.Result === 'Pass' ? 'ok' : 'danger') + '">' + esc(r.Result) + '</span></td>' +
    '<td><button class="btn sm danger" data-del="' + esc(r.ID) + '">\uD83D\uDDD1</button></td></tr>'
  ).join('') || noRow(9);
  $$('#termFinalTable [data-del]').forEach((b) =>
    b.addEventListener('click', () => deleteRecord('/api/termfinals/delete', b.dataset.del))
  );
}

function updateTermPreview(t) {
  const w = num($('#tfW' + t).value), o = num($('#tfO' + t).value), p = num($('#tfP' + t).value);
  const total = w + o + p;
  const percentage = pctOf(total, TERM_FULL);
  const el = $('#tfPrev' + t);
  if (el) {
    el.innerHTML = '<span>Total: <strong>' + total + '</strong> / ' + TERM_FULL + '</span>' +
      '<span>' + percentage + '% \u00B7 ' + gradeOf(percentage) + ' \u00B7 ' +
      (percentage >= PASS_PERCENT ? '<span class="badge ok">Pass</span>' : '<span class="badge danger">Fail</span>') + '</span>';
  }
}

async function saveTermFinal(e) {
  const t = e.currentTarget.dataset.term;
  const w = $('#tfW' + t).value, o = $('#tfO' + t).value, p = $('#tfP' + t).value;
  if (w === '' && o === '' && p === '') { toast('Enter marks for ' + TERM_NAMES[t] + ' first', 'error'); return; }
  try {
    await apiPost('/api/termfinals', {
      studentId: state.selected,
      term: Number(t),
      examDate: $('#tfDate' + t).value,
      written: num(w), oral: num(o), practical: num(p),
      remarks: $('#tfRem' + t).value.trim(),
    });
    toast('\uD83D\uDCBE ' + TERM_NAMES[t] + ' final saved', 'success');
    loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

/* ============================================================
   TERM FINAL RE-TAKE
   Full duplicate of the Term Final tab. Re-takes reuse the same
   TermFinals sheet/database with term numbers 11/12/13 so they are
   stored as separate records and never overwrite regular terms.
   ============================================================ */

function retakeRecordFor(t) {
  const target = RETAKE_TERM[t];
  return state.termFinals.find((r) =>
    String(r.StudentID) === String(state.selected) && Number(r.Term) === Number(target));
}

function renderRetakeFinal() {
  const s = selStudent();
  const grid = $('#retakeFinalForms');
  if (!s) {
    grid.innerHTML = emptyState('Add a student first.');
    $('#retakeFinalTable tbody').innerHTML = '';
    return;
  }
  grid.innerHTML = [1, 2, 3].map((t) => {
    const r = retakeRecordFor(t) || {};
    const badge = r.Result
      ? '<span class="badge ' + (r.Result === 'Pass' ? 'ok' : 'danger') + '">' + esc(r.Result) + ' \u00B7 ' + esc(r.Percentage) + '%</span>'
      : '<span class="mini">Not recorded</span>';
    return '<div class="mini-card">' +
      '<h3>' + TERM_NAMES[t] + ' re-take</h3>' +
      '<div class="form-grid">' +
        '<label>Exam date<input type="date" id="rtDate' + t + '" value="' + esc(r.ExamDate || '') + '" /></label>' +
        '<label>Written (max ' + TERM_COMPONENTS.written + ')<input type="number" min="0" id="rtW' + t + '" value="' + (r.Written != null ? esc(r.Written) : '') + '" /></label>' +
        '<label>Oral / viva (max ' + TERM_COMPONENTS.oral + ')<input type="number" min="0" id="rtO' + t + '" value="' + (r.Oral != null ? esc(r.Oral) : '') + '" /></label>' +
        '<label>Practical (max ' + TERM_COMPONENTS.practical + ')<input type="number" min="0" id="rtP' + t + '" value="' + (r.Practical != null ? esc(r.Practical) : '') + '" /></label>' +
        '<label>Remarks<input id="rtRem' + t + '" value="' + esc(r.Remarks || '') + '" /></label>' +
      '</div>' +
      '<div class="total-preview" id="rtPrev' + t + '"><span>Total: \u2014</span><span>\u2014%</span></div>' +
      '<div class="mini-card-foot">' + badge +
        '<button class="btn primary sm" data-retake="' + t + '">\uD83D\uDCBE Save</button>' +
      '</div></div>';
  }).join('');

  [1, 2, 3].forEach((t) => {
    ['rtW' + t, 'rtO' + t, 'rtP' + t].forEach((id) =>
      $('#' + id).addEventListener('input', () => updateRetakePreview(t)));
    updateRetakePreview(t);
  });

  $$('#retakeFinalForms [data-retake]').forEach((b) => b.addEventListener('click', saveRetakeFinal));

  const rows = state.termFinals
    .filter((r) => String(r.StudentID) === String(state.selected))
    .filter((r) => [11, 12, 13].indexOf(Number(r.Term)) >= 0)
    .sort((a, b) => a.Term - b.Term);
  $('#retakeFinalTable tbody').innerHTML = rows.map((r) =>
    '<tr><td>' + esc(termDisplayName(r.Term)) + '</td><td>' + esc(r.ExamDate || '\u2014') + '</td>' +
    '<td>' + esc(r.Written) + '</td><td>' + esc(r.Oral) + '</td><td>' + esc(r.Practical) + '</td>' +
    '<td><strong>' + esc(r.Total) + '</strong> / ' + TERM_FULL + '</td><td>' + esc(r.Percentage) + '%</td>' +
    '<td><span class="badge ' + (r.Result === 'Pass' ? 'ok' : 'danger') + '">' + esc(r.Result) + '</span></td>' +
    '<td><button class="btn sm danger" data-del="' + esc(r.ID) + '">\uD83D\uDDD1</button></td></tr>'
  ).join('') || noRow(9);
  $$('#retakeFinalTable [data-del]').forEach((b) =>
    b.addEventListener('click', () => deleteRecord('/api/termfinals/delete', b.dataset.del))
  );
}

function updateRetakePreview(t) {
  const w = num($('#rtW' + t).value), o = num($('#rtO' + t).value), p = num($('#rtP' + t).value);
  const total = w + o + p;
  const percentage = pctOf(total, TERM_FULL);
  const el = $('#rtPrev' + t);
  if (el) {
    el.innerHTML = '<span>Total: <strong>' + total + '</strong> / ' + TERM_FULL + '</span>' +
      '<span>' + percentage + '% \u00B7 ' + gradeOf(percentage) + ' \u00B7 ' +
      (percentage >= PASS_PERCENT ? '<span class="badge ok">Pass</span>' : '<span class="badge danger">Fail</span>') + '</span>';
  }
}

async function saveRetakeFinal(e) {
  const t = e.currentTarget.dataset.retake;
  const w = $('#rtW' + t).value, o = $('#rtO' + t).value, p = $('#rtP' + t).value;
  if (w === '' && o === '' && p === '') { toast('Enter marks for ' + TERM_NAMES[t] + ' re-take first', 'error'); return; }
  try {
    await apiPost('/api/termfinals', {
      studentId: state.selected,
      term: RETAKE_TERM[t],              // 11/12/13 → stored as separate re-take records
      examDate: $('#rtDate' + t).value,
      written: num(w), oral: num(o), practical: num(p),
      remarks: $('#rtRem' + t).value.trim(),
    });
    toast('\uD83D\uDCBE ' + TERM_NAMES[t] + ' re-take saved', 'success');
    loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

/* ============================================================
   ATTENDANCE
   ============================================================ */

function attRecordFor(t) {
  return state.attendance.find((r) =>
    String(r.StudentID) === String(state.selected) && Number(r.Term) === Number(t));
}

function renderAttendance() {
  const s = selStudent();
  const grid = $('#attendanceForms');
  if (!s) { grid.innerHTML = emptyState('Add a student first.'); return; }

  grid.innerHTML = [1, 2, 3].map((t) => {
    const r = attRecordFor(t) || {};
    const row = (kind, aId, tId, aVal, tVal) =>
      '<div class="att-row">' +
        '<span class="att-lbl">' + kind + '</span>' +
        '<label>Attended<input type="number" min="0" id="' + aId + '" value="' + esc(aVal || '') + '" /></label>' +
        '<label>Total classes<input type="number" min="0" id="' + tId + '" value="' + esc(tVal || '') + '" /></label>' +
        '<span class="att-pct" id="' + aId + 'Pct" style="padding-bottom:10px;">\u2014</span>' +
      '</div>';
    return '<div class="mini-card">' +
      '<h3>' + TERM_NAMES[t] + '</h3>' +
      row('Lecture', 'atL' + t, 'toL' + t, r.LectureAttended, r.LectureTotal) +
      row('Tutorial', 'atT' + t, 'toT' + t, r.TutorialAttended, r.TutorialTotal) +
      row('Practical', 'atP' + t, 'toP' + t, r.PracticalAttended, r.PracticalTotal) +
      '<label>Remarks<input id="atRem' + t + '" value="' + esc(r.Remarks || '') + '" /></label>' +
      '<div class="mini-card-foot">' +
        '<span class="mini">requirement \u2265 ' + ATTENDANCE_WARN + '%</span>' +
        '<button class="btn primary sm" data-att="' + t + '">\uD83D\uDCBE Save</button>' +
        '<span class="att-points" id="atPts' + t + '" style="font-weight:700;">\u2014</span>' +
      '</div></div>';
  }).join('');

  [1, 2, 3].forEach((t) => {
    ['atL' + t, 'toL' + t, 'atT' + t, 'toT' + t, 'atP' + t, 'toP' + t].forEach((id) =>
      $('#' + id).addEventListener('input', () => updateAttPreview(t)));
    updateAttPreview(t);
  });

  $$('#attendanceForms [data-att]').forEach((b) => b.addEventListener('click', saveAttendance));
}

/* Attendance points: average of the three class-type percentages
   <75% -> 0   |   75-89% -> 1   |   90-100% -> 2 */
function attPointsOf(pct) {
  if (pct == null) return null;
  return pct >= 90 ? 2 : pct >= 75 ? 1 : 0;
}

function updateAttPreview(t) {
  const pairs = [['atL' + t, 'toL' + t], ['atT' + t, 'toT' + t], ['atP' + t, 'toP' + t]];
  let sum = 0, counted = 0;
  pairs.forEach((pair) => {
    const a = num($('#' + pair[0]).value), tot = num($('#' + pair[1]).value);
    const p = pctOf(a, tot);
    const el = $('#' + pair[0] + 'Pct');
    el.innerHTML = '<span class="' + (tot > 0 && p < ATTENDANCE_WARN ? 'pct-bad' : '') + '">' + p + '%</span>';
    if (tot > 0) { sum += p; counted++; }
  });
  const ptsEl = $('#atPts' + t);
  if (ptsEl) {
    if (!counted) { ptsEl.innerHTML = '<span class="mini">Points: \u2014</span>'; }
    else {
      const avg = Math.round((sum / counted) * 10) / 10;
      const pts = attPointsOf(avg);
      ptsEl.innerHTML = 'Points: <span class="badge ' + (pts === 2 ? 'ok' : pts === 1 ? 'warn' : 'danger') + '">' +
        pts + '</span> <span class="mini">(' + avg + '%)</span>';
    }
  }
}

async function saveAttendance(e) {
  const t = e.currentTarget.dataset.att;
  try {
    await apiPost('/api/attendance', {
      studentId: state.selected,
      term: Number(t),
      lectureAttended: num($('#atL' + t).value),
      lectureTotal: num($('#toL' + t).value),
      tutorialAttended: num($('#atT' + t).value),
      tutorialTotal: num($('#toT' + t).value),
      practicalAttended: num($('#atP' + t).value),
      practicalTotal: num($('#toP' + t).value),
      remarks: $('#atRem' + t).value.trim(),
    });
    toast('\uD83D\uDCBE ' + TERM_NAMES[t] + ' attendance saved', 'success');
    loadAll();
  } catch (err) { toast(err.message, 'error'); }
}

/* ============================================================
   DASHBOARD
   ============================================================ */

function statCard(numText, label, cls) {
  return '<div class="stat-card ' + cls + '"><div class="num">' + numText + '</div><div class="lbl">' + esc(label) + '</div></div>';
}

function renderDashboard() {
  const total = state.students.length;
  const first = state.students.filter((s) => s.Year === '1st Year').length;
  const done = state.pending.filter((i) => i.Status === 'Done').length;
  const ex = state.pending.filter((i) => i.Status === 'Exempted').length;
  const pending = state.pending.length - done - ex;
  const cf = state.cardFinals.length;
  const tf = state.termFinals.length;

  const alerts = state.attendance.filter((a) =>
    (num(a.LectureTotal) > 0 || num(a.TutorialTotal) > 0 || num(a.PracticalTotal) > 0) &&
    (num(a.LecturePercent) < ATTENDANCE_WARN || num(a.TutorialPercent) < ATTENDANCE_WARN || num(a.PracticalPercent) < ATTENDANCE_WARN));

  /* ---- Students academic record: card final / term final / attendance % ---- */
  const attCell = (rows, aField, tField) => {
    let a = 0, tot = 0;
    rows.forEach((r) => { a += num(r[aField]); tot += num(r[tField]); });
    if (tot <= 0) return '\u2014';
    const p = pctOf(a, tot);
    return '<span class="' + (p < ATTENDANCE_WARN ? 'pct-bad' : '') + '">' + p + '%</span>';
  };

  const record = state.students.slice()
    .sort((a, b) => (num(a.Roll) - num(b.Roll)) || String(a.Name).localeCompare(String(b.Name)));

  $('#dashPendingTable tbody').innerHTML = record.map((s) => {
    const cfRows = state.cardFinals.filter((r) => String(r.StudentID) === String(s.ID));
    const cfAvg = cfRows.length
      ? Math.round(cfRows.reduce((t, r) => t + num(r.Percentage), 0) / cfRows.length * 10) / 10
      : null;
    const cfCell = cfRows.length
      ? '<strong>' + cfAvg + '%</strong> <span class="mini">avg \u00B7 ' + cfRows.length + '/6 cards</span>'
      : '\u2014';

    const tfRows = state.termFinals.filter((r) => String(r.StudentID) === String(s.ID) && Number(r.Term) <= 3);
    let tfCell = '\u2014';
    if (tfRows.length) {
      const tfAvg = Math.round(tfRows.reduce((t, r) => t + num(r.Percentage), 0) / tfRows.length * 10) / 10;
      const passed = tfRows.filter((r) => r.Result === 'Pass').length;
      const anyFail = passed < tfRows.length;
      tfCell = '<strong>' + tfAvg + '%</strong> <span class="badge ' + (anyFail ? 'danger' : 'ok') + '">' +
        passed + '/' + tfRows.length + ' Pass</span>';
    }

    const att = state.attendance.filter((r) => String(r.StudentID) === String(s.ID));

    return '<tr class="row-click" data-id="' + esc(s.ID) + '"><td>' + esc(s.Roll) + '</td><td>' + esc(s.Name) + '</td><td>' + esc(s.Year) + '</td>' +
      '<td>' + (studentPendingCount(s.ID) > 0
        ? '<span class="badge warn">' + studentPendingCount(s.ID) + ' pending</span>'
        : '<span class="badge ok">all done</span>') + '</td>' +
      '<td>' + cfCell + '</td><td>' + tfCell + '</td>' +
      '<td>' + attCell(att, 'LectureAttended', 'LectureTotal') + '</td>' +
      '<td>' + attCell(att, 'TutorialAttended', 'TutorialTotal') + '</td>' +
      '<td>' + attCell(att, 'PracticalAttended', 'PracticalTotal') + '</td></tr>';
  }).join('') || noRow(9);
  $$('#dashPendingTable [data-id]').forEach((tr) =>
    tr.addEventListener('click', () => { state.selected = tr.dataset.id; renderAll(); switchTab('pending'); }));

  const cell = (p, tot) => (num(tot) > 0
    ? '<span class="' + (num(p) < ATTENDANCE_WARN ? 'pct-bad' : '') + '">' + num(p) + '%</span>'
    : '\u2014');
  $('#dashAttTable tbody').innerHTML = alerts.map((a) =>
    '<tr><td>' + esc(a.Roll) + '</td><td>' + esc(a.Name) + '</td><td>' + esc(TERM_NAMES[a.Term] || a.Term) + '</td>' +
    '<td>' + cell(a.LecturePercent, a.LectureTotal) + '</td>' +
    '<td>' + cell(a.TutorialPercent, a.TutorialTotal) + '</td>' +
    '<td>' + cell(a.PracticalPercent, a.PracticalTotal) + '</td></tr>'
  ).join('') || noRow(6);
}

/* ============================================================
   EVENT WIRING & INIT
   ============================================================ */

function wireEvents() {
  $$('#tabs .tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#btnRefresh').addEventListener('click', loadAll);
  $('#studentForm').addEventListener('submit', onStudentSubmit);
  $('#studentCancel').addEventListener('click', resetStudentForm);
  /* search: 'input' covers typing/paste/cut; 'change' is a fallback for
     autofill and some IME/mobile keyboards that skip input events */
  $('#studentSearch').addEventListener('input', renderStudents);
  $('#studentSearch').addEventListener('change', renderStudents);
  /* year filter buttons (All / 1st Year / 2nd Year) */
  $$('#yearFilter .btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.studentYearFilter = b.dataset.year || 'All';
      $$('#yearFilter .btn').forEach((x) => x.classList.toggle('primary', x === b));
      renderStudents();
    })
  );
  $('#pendingFilter').addEventListener('change', (e) => { state.pendingFilter = e.target.value; renderPending(); });
  $('#btnReseed').addEventListener('click', onReseed);

  /* confirm dialog */
  $('#confirmOk').addEventListener('click', () => closeConfirm(true));
  $('#confirmCancel').addEventListener('click', () => closeConfirm(false));
  $('#confirmModal').addEventListener('click', (e) => { if (e.target.id === 'confirmModal') closeConfirm(false); });
  document.addEventListener('keydown', (e) => {
    if ($('#confirmModal').classList.contains('hidden')) return;
    if (e.key === 'Escape') closeConfirm(false);
    if (e.key === 'Enter') { e.preventDefault(); closeConfirm(true); }
  });

  [['#pendingStudent', renderPending], ['#cardStudent', renderCardFinal],
    ['#termStudent', renderTermFinal], ['#retakeStudent', renderRetakeFinal],
    ['#attStudent', renderAttendance]]
    .forEach((pair) => {
      $(pair[0]).addEventListener('change', (e) => {
        state.selected = e.target.value || null;
        populateSelects();
        renderDashboard();
        pair[1]();
      });
    });
}

wireEvents();
initAuth();






