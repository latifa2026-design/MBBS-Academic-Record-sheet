/**
 * Offline test harness for apps-script/Code.gs
 * ------------------------------------------------------------
 * Simulates the Google Apps Script environment (SpreadsheetApp,
 * PropertiesService, Utilities, Session, ContentService, Logger)
 * with an in-memory spreadsheet, then runs the REAL Code.gs
 * through a full end-to-end data test.
 *
 * Run:   node dev-test/gas-mock-test.js
 * (any Node >= 14; no dependencies)
 */
'use strict';

/* ======================= GAS MOCKS ======================= */

function MockRange(sheet, row, col, numRows, numCols) {
  this.sheet = sheet;
  this.row = row;
  this.col = col;
  this.numRows = numRows || 1;
  this.numCols = numCols || 1;
}

MockRange.prototype.getValues = function () {
  const out = [];
  for (let r = 0; r < this.numRows; r++) {
    const src = this.sheet.data[this.row - 1 + r] || [];
    const line = [];
    for (let c = 0; c < this.numCols; c++) line.push(src[this.col - 1 + c] !== undefined ? src[this.col - 1 + c] : '');
    out.push(line);
  }
  return out;
};

MockRange.prototype.setValues = function (values) {
  for (let r = 0; r < values.length; r++) {
    while (this.sheet.data.length < this.row + r) this.sheet.data.push([]);
    const target = this.sheet.data[this.row - 1 + r];
    for (let c = 0; c < values[r].length; c++) target[this.col - 1 + c] = values[r][c];
  }
  return this;
};

MockRange.prototype.getValue = function () {
  const v = this.getValues();
  return v[0][0];
};

MockRange.prototype.setValue = function (v) {
  return this.setValues([[v]]);
};

['setFontWeight', 'setBackground', 'setFontColor', 'setNumberFormat'].forEach((m) => {
  MockRange.prototype[m] = function () { return this; };
});

function MockSheet(name) {
  this.name = name;
  this.data = [];
}

MockSheet.prototype.getName = function () { return this.name; };
MockSheet.prototype.getLastRow = function () { return this.data.length; };
MockSheet.prototype.getLastColumn = function () {
  let max = 0;
  this.data.forEach((r) => { if (r.length > max) max = r.length; });
  return max;
};
MockSheet.prototype.getRange = function (row, col, numRows, numCols) {
  return new MockRange(this, row, col, numRows, numCols);
};
MockSheet.prototype.appendRow = function (row) {
  this.data.push(row.slice());
  return this;
};
MockSheet.prototype.deleteRow = function (row) {
  this.data.splice(row - 1, 1);
  return this;
};
MockSheet.prototype.setFrozenRows = function () { return this; };

function MockSpreadsheet(name) {
  this.name = name;
  this.id = 'mock-ss-' + Math.floor(Math.random() * 1e9);
  this.sheets = [new MockSheet('Sheet1')];
}

MockSpreadsheet.prototype.getName = function () { return this.name; };
MockSpreadsheet.prototype.getId = function () { return this.id; };
MockSpreadsheet.prototype.getUrl = function () { return 'https://docs.google.com/spreadsheets/d/' + this.id; };
MockSpreadsheet.prototype.getSheets = function () { return this.sheets; };
MockSpreadsheet.prototype.getSheetByName = function (name) {
  return this.sheets.find((s) => s.name === name) || null;
};
MockSpreadsheet.prototype.insertSheet = function (name) {
  const sh = new MockSheet(name);
  this.sheets.push(sh);
  return sh;
};
MockSpreadsheet.prototype.deleteSheet = function (sh) {
  this.sheets = this.sheets.filter((s) => s !== sh);
};

const mockStore = { props: {}, spreadsheets: {} };

globalThis.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => (k in mockStore.props ? mockStore.props[k] : null),
    setProperty: (k, v) => { mockStore.props[k] = String(v); },
  }),
};

globalThis.SpreadsheetApp = {
  create: (name) => {
    const ss = new MockSpreadsheet(name);
    mockStore.spreadsheets[ss.id] = ss;
    return ss;
  },
  openById: (id) => {
    const ss = mockStore.spreadsheets[id];
    if (!ss) throw new Error('Spreadsheet not found: ' + id);
    return ss;
  },
};

let uuidCounter = 0;
globalThis.Utilities = {
  getUuid: () => 'uuid-' + (++uuidCounter),
  formatDate: (d) => d.toISOString().slice(0, 10),
};

globalThis.Session = { getScriptTimeZone: () => 'UTC' };

globalThis.Logger = { log: (m) => console.log('   [GAS log] ' + m) };

globalThis.ContentService = {
  MimeType: { JSON: 'application/json' },
  createTextOutput: (text) => ({
    text,
    setMimeType() { return this; },
    getContent() { return this.text; },
  }),
};

/* ======================= LOAD REAL Code.gs ======================= */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const codeGs = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
vm.runInThisContext(codeGs, { filename: 'Code.gs' });

/* ======================= TEST RUNNER ======================= */

let passCount = 0;
let failCount = 0;

function check(name, cond, extra) {
  if (cond) { passCount++; console.log('   PASS  ' + name); }
  else { failCount++; console.log('   FAIL  ' + name + (extra !== undefined ? '  ->  ' + JSON.stringify(extra) : '')); }
}

function call(req) {
  return JSON.parse(route_(req).getContent());
}

console.log('\n=== 1. setup() creates the database ===');
setup();
check('spreadsheet id stored in script properties', !!mockStore.props.SPREADSHEET_ID);
const ss = SpreadsheetApp.openById(mockStore.props.SPREADSHEET_ID);
check('all 5 sheets exist',
  ['Students', 'PendingItems', 'CardFinals', 'TermFinals', 'Attendance'].every((n) => !!ss.getSheetByName(n)),
  ss.sheets.map((s) => s.name));
check('default Sheet1 removed', !ss.getSheetByName('Sheet1'));

console.log('\n=== 2. router security ===');
const pong = call({ token: 'mbbs-record-2026', action: 'ping' });
check('valid token accepted (ping)', pong.ok === true && pong.data === 'pong', pong);
const denied = call({ token: 'wrong-token', action: 'listStudents' });
check('invalid token rejected', denied.ok === false && /Unauthorized/.test(denied.error), denied);

console.log('\n=== 3. add students (47 items auto-seeded) ===');
const add1 = call({ token: 'mbbs-record-2026', action: 'addStudent', data: { roll: '2026015', name: 'Ayesha Rahman', year: '1st Year', session: '2025-26' } });
check('student 1 added, 47 items seeded', add1.ok === true && add1.data.seeded === 47, add1);
const add2 = call({ token: 'mbbs-record-2026', action: 'addStudent', data: { roll: '2026016', name: 'Rafiq Ahmed', year: '1st Year', session: '2025-26' } });
check('student 2 added', add2.ok === true);
const dup = call({ token: 'mbbs-record-2026', action: 'addStudent', data: { roll: '2026015', name: 'Duplicate' } });
check('duplicate roll rejected', dup.ok === false && /already exists/.test(dup.error), dup);
const students = call({ token: 'mbbs-record-2026', action: 'listStudents' }).data;
check('2 students listed', students.length === 2);
check('student fields correct', students[0].Roll === '2026015' && students[0].Name === 'Ayesha Rahman' && students[0].Year === '1st Year', students[0]);

console.log('\n=== 4. pending items structure (6 cards / 47 items) ===');
const pending = call({ token: 'mbbs-record-2026', action: 'listPending' }).data;
check('94 rows total (2 students x 47)', pending.length === 94, pending.length);
const s1Items = pending.filter((p) => String(p.StudentID) === String(students[0].ID));
check('47 items for student 1', s1Items.length === 47);
const byCardSub = {};
s1Items.forEach((i) => {
  const k = i.Term + '|' + i.Card + '|' + i.Subject;
  byCardSub[k] = (byCardSub[k] || 0) + 1;
});
check('Card1 Cellular = 5', byCardSub['1|1|Cellular Physiology'] === 5, byCardSub);
check('Card1 Blood = 5', byCardSub['1|1|Blood Physiology'] === 5);
check('Card2 CVS = 6', byCardSub['1|2|Cardiovascular System'] === 6);
check('Card3 Respiratory = 5', byCardSub['2|3|Respiratory System'] === 5);
check('Card4 GIT & Renal = 7', byCardSub['2|4|GIT & Renal System'] === 7);
check('Card5 Endocrine & Repro = 9', byCardSub['3|5|Endocrinology & Reproductive System'] === 9);
check('Card6 Nervous = 10', byCardSub['3|6|Nervous System'] === 10);

console.log('\n=== 5. mark pending items ===');
const item1 = s1Items[0];
const upd = call({ token: 'mbbs-record-2026', action: 'updatePendingItem', data: { id: item1.ID, status: 'Done' } });
check('item marked Done with date', upd.ok && upd.data.status === 'Done' && !!upd.data.doneDate, upd);
const afterDone = call({ token: 'mbbs-record-2026', action: 'listPending' }).data.find((p) => p.ID === item1.ID);
check('DoneDate persisted in sheet', afterDone.Status === 'Done' && afterDone.DoneDate !== '', afterDone);
const upd2 = call({ token: 'mbbs-record-2026', action: 'updatePendingItem', data: { id: s1Items[1].ID, status: 'Exempted' } });
check('item marked Exempted (no date)', upd2.ok && upd2.data.status === 'Exempted' && upd2.data.doneDate === '');
const reseed = call({ token: 'mbbs-record-2026', action: 'reseedPending', data: { studentId: students[0].ID } });
check('re-seed adds 0 missing rows', reseed.ok && reseed.data.added === 0, reseed);

console.log('\n=== 6. card final (upsert + auto % + grade) ===');
const cf1 = call({ token: 'mbbs-record-2026', action: 'saveCardFinal', data: { studentId: students[0].ID, card: 1, examDate: '2026-02-10', marksObtained: 80, marksTotal: 100 } });
check('card final added, 80% = A+', cf1.ok && cf1.data.added && cf1.data.percentage === 80 && cf1.data.grade === 'A+', cf1);
const cf1b = call({ token: 'mbbs-record-2026', action: 'saveCardFinal', data: { studentId: students[0].ID, card: 1, marksObtained: 91, marksTotal: 100 } });
check('card final re-save UPDATES (upsert)', cf1b.ok && cf1b.data.updated === true && cf1b.data.percentage === 91, cf1b);
const cfList = call({ token: 'mbbs-record-2026', action: 'listCardFinals' }).data;
check('only 1 card final row for card 1', cfList.filter((r) => Number(r.Card) === 1).length === 1, cfList.length);
const cf2 = call({ token: 'mbbs-record-2026', action: 'saveCardFinal', data: { studentId: students[0].ID, card: 2, marksObtained: 45, marksTotal: 100 } });
check('45% graded C', cf2.data.grade === 'C', cf2.data);
const cf3 = call({ token: 'mbbs-record-2026', action: 'saveCardFinal', data: { studentId: students[0].ID, card: 3, marksObtained: 35, marksTotal: 100 } });
check('35% graded F', cf3.data.grade === 'F', cf3.data);
check('card subject auto-filled', cfList[0].Subject === 'Cellular & Blood Physiology', cfList[0]);

console.log('\n=== 7. term final (auto total / % / pass-fail) ===');
const tf1 = call({ token: 'mbbs-record-2026', action: 'saveTermFinal', data: { studentId: students[0].ID, term: 1, written: 80, oral: 90, practical: 85 } });
check('term1 total=255, %=85, Pass', tf1.ok && tf1.data.total === 255 && tf1.data.percentage === 85 && tf1.data.result === 'Pass', tf1);
const tf1b = call({ token: 'mbbs-record-2026', action: 'saveTermFinal', data: { studentId: students[0].ID, term: 1, written: 50, oral: 60, practical: 55 } });
check('term final upsert (165 -> Fail at <60%)',
  tf1b.data.updated && tf1b.data.total === 165 && tf1b.data.percentage === 55 && tf1b.data.result === 'Fail', tf1b);
const tf2 = call({ token: 'mbbs-record-2026', action: 'saveTermFinal', data: { studentId: students[0].ID, term: 2, written: 90, oral: 95, practical: 88 } });
check('term2 Pass', tf2.data.result === 'Pass');
const tfList = call({ token: 'mbbs-record-2026', action: 'listTermFinals' }).data;
check('2 term final rows (upsert, not append)', tfList.length === 2, tfList.length);

console.log('\n=== 8. attendance (auto %) ===');
const at1 = call({ token: 'mbbs-record-2026', action: 'saveAttendance', data: { studentId: students[0].ID, term: 1, lectureAttended: 18, lectureTotal: 20, tutorialAttended: 20, tutorialTotal: 24, practicalAttended: 12, practicalTotal: 12 } });
check('attendance saved', at1.ok, at1);
const a1 = call({ token: 'mbbs-record-2026', action: 'listAttendance' }).data.find((r) => r.Term === 1);
check('lecture % = 90', a1.LecturePercent === 90, a1);
check('tutorial % = 83.3', a1.TutorialPercent === 83.3);
check('practical % = 100', a1.PracticalPercent === 100);
const at2 = call({ token: 'mbbs-record-2026', action: 'saveAttendance', data: { studentId: students[0].ID, term: 2, lectureAttended: 10, lectureTotal: 20, tutorialAttended: 8, tutorialTotal: 20, practicalAttended: 5, practicalTotal: 10 } });
check('term2 saved', at2.ok);
const a2 = call({ token: 'mbbs-record-2026', action: 'listAttendance' }).data.find((r) => r.Term === 2);
check('term2 lecture % = 50 (below 75 warning)', a2.LecturePercent === 50);
check('term2 tutorial % = 40', a2.TutorialPercent === 40);
call({ token: 'mbbs-record-2026', action: 'saveAttendance', data: { studentId: students[0].ID, term: 1, lectureAttended: 20, lectureTotal: 20, tutorialAttended: 24, tutorialTotal: 24, practicalAttended: 12, practicalTotal: 12 } });
const a1b = call({ token: 'mbbs-record-2026', action: 'listAttendance' }).data.find((r) => r.Term === 1);
check('attendance upsert (term1 now 100/100/100)', a1b.LecturePercent === 100 && a1b.TutorialPercent === 100 && a1b.PracticalPercent === 100, a1b);
check('still only 2 attendance rows', call({ token: 'mbbs-record-2026', action: 'listAttendance' }).data.length === 2);

console.log('\n=== 9. update student cascades Roll/Name everywhere ===');
const updSt = call({ token: 'mbbs-record-2026', action: 'updateStudent', data: { id: students[0].ID, name: 'Ayesha Rahman (Corr.)' } });
check('update ok', updSt.ok);
const pendAfter = call({ token: 'mbbs-record-2026', action: 'listPending' }).data.filter((p) => String(p.StudentID) === String(students[0].ID));
check('pending rows carry updated name', pendAfter.every((p) => p.Name === 'Ayesha Rahman (Corr.)'), pendAfter[0]);
const cfAfter = call({ token: 'mbbs-record-2026', action: 'listCardFinals' }).data.filter((p) => String(p.StudentID) === String(students[0].ID));
check('card final rows carry updated name', cfAfter.every((p) => p.Name === 'Ayesha Rahman (Corr.)'));

console.log('\n=== 10. delete student cascades all rows ===');
const del = call({ token: 'mbbs-record-2026', action: 'deleteStudent', data: { id: students[0].ID } });
check('delete ok', del.ok, del);
check('students now 1', call({ token: 'mbbs-record-2026', action: 'listStudents' }).data.length === 1);
check('student1 pending rows removed', call({ token: 'mbbs-record-2026', action: 'listPending' }).data.every((p) => String(p.StudentID) !== String(students[0].ID)));
check('student1 card finals removed', call({ token: 'mbbs-record-2026', action: 'listCardFinals' }).data.length === 0);
check('student1 term finals removed', call({ token: 'mbbs-record-2026', action: 'listTermFinals' }).data.length === 0);
check('student1 attendance removed', call({ token: 'mbbs-record-2026', action: 'listAttendance' }).data.length === 0);

console.log('\n=== 11. validation errors ===');
const noRoll = call({ token: 'mbbs-record-2026', action: 'addStudent', data: { name: 'No roll' } });
check('addStudent without roll rejected', noRoll.ok === false);
const badPending = call({ token: 'mbbs-record-2026', action: 'updatePendingItem', data: { id: 'missing-id', status: 'Done' } });
check('updating missing item -> clear error', badPending.ok === false && /not found/i.test(badPending.error), badPending);
const unknown = call({ token: 'mbbs-record-2026', action: 'madeUpAction' });
check('unknown action -> clear error', unknown.ok === false && /Unknown action/.test(unknown.error), unknown);
const missingStu = call({ token: 'mbbs-record-2026', action: 'saveCardFinal', data: { studentId: 'no-such-id', card: 1, marksObtained: 50 } });
check('saving result for missing student -> clear error', missingStu.ok === false && /not found/i.test(missingStu.error), missingStu);

console.log('\n=========================================================');
console.log('RESULT: ' + passCount + ' passed, ' + failCount + ' failed');
console.log('=========================================================');
process.exit(failCount > 0 ? 1 : 0);



