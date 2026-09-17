/**
 * =====================================================================
 *  MBBS ACADEMIC RECORD SHEET — Google Apps Script backend (Code.gs)
 *  ---------------------------------------------------------------------
 *  Database : Google Sheets (auto-created on first run, or set
 *             CONFIG.SPREADSHEET_ID below to use an existing sheet)
 *  Used by  : Node.js server of this project (server.js + config.js)
 *
 *  SETUP (5 steps)
 *  1. Paste this whole file into your Apps Script project.
 *  2. Set CONFIG.TOKEN (same value as TOKEN in config.js).
 *  3. Run setup() once from the toolbar and authorise.
 *  4. Deploy > New deployment > Web app
 *        Execute as     : Me
 *        Who has access : Anyone
 *     Copy the Web App URL (ends with /exec).
 *  5. Paste that URL into config.js (APPS_SCRIPT_URL), then run
 *     "node server.js" and open http://localhost:3000
 *
 *  NOTE: every time you edit this file you must publish a new version:
 *        Deploy > Manage deployments > pencil icon > Version: New version
 * =====================================================================
 */

var CONFIG = {
  // Must be identical to TOKEN in config.js
  TOKEN: 'mbbs-record-2026',

  // Leave '' to auto-create the Google Sheet on first run,
  // or paste an existing Google Sheet ID here.
  SPREADSHEET_ID: '',

  // ---- Marking scheme (edit to match your institution) ----
  TERM_COMPONENTS: { WRITTEN: 100, ORAL: 100, PRACTICAL: 100 },
  PASS_PERCENT: 60,          // term-final pass mark (%)
  CARD_FULL_MARKS: 100,      // default full marks of a card final
  ATTENDANCE_WARN_PERCENT: 75
};

/* Sheet definitions (tab name -> column headers) */
var SHEETS = {
  STUDENTS:   { name: 'Students',     headers: ['ID', 'Roll', 'Name', 'Year', 'Session', 'Status', 'CreatedAt'] },
  PENDING:    { name: 'PendingItems', headers: ['ID', 'StudentID', 'Roll', 'Name', 'Term', 'Card', 'Subject', 'ItemNo', 'ItemLabel', 'Status', 'DoneDate', 'Remarks'] },
  CARDFINALS: { name: 'CardFinals',   headers: ['ID', 'StudentID', 'Roll', 'Name', 'Term', 'Card', 'Subject', 'ExamDate', 'MarksObtained', 'MarksTotal', 'Percentage', 'Grade', 'Remarks', 'UpdatedAt'] },
  TERMFINALS: { name: 'TermFinals',   headers: ['ID', 'StudentID', 'Roll', 'Name', 'Term', 'ExamDate', 'Written', 'Oral', 'Practical', 'Total', 'Percentage', 'Result', 'Remarks', 'UpdatedAt'] },
  ATTENDANCE: { name: 'Attendance',   headers: ['ID', 'StudentID', 'Roll', 'Name', 'Term', 'LectureTotal', 'LectureAttended', 'TutorialTotal', 'TutorialAttended', 'PracticalTotal', 'PracticalAttended', 'LecturePercent', 'TutorialPercent', 'PracticalPercent', 'Remarks', 'UpdatedAt'] }
};

/* ============================================================
   COURSE STRUCTURE
   1st term : Card 1 = Cellular Physiology (5) + Blood Physiology (5)
              Card 2 = Cardiovascular System (6)
   2nd term : Card 3 = Respiratory System (5)
              Card 4 = GIT & Renal System (7)
   3rd term : Card 5 = Endocrinology & Reproductive (9)
              Card 6 = Nervous System (10)
   ============================================================ */
var ITEM_MASTER = [
  { term: 1, card: 1, subject: 'Cellular Physiology', count: 5 },
  { term: 1, card: 1, subject: 'Blood Physiology', count: 5 },
  { term: 1, card: 2, subject: 'Cardiovascular System', count: 6 },
  { term: 2, card: 3, subject: 'Respiratory System', count: 5 },
  { term: 2, card: 4, subject: 'GIT & Renal System', count: 7 },
  { term: 3, card: 5, subject: 'Endocrinology & Reproductive System', count: 9 },
  { term: 3, card: 6, subject: 'Nervous System', count: 10 }
];

var CARD_SUBJECTS = {
  1: 'Cellular & Blood Physiology',
  2: 'Cardiovascular System',
  3: 'Respiratory System',
  4: 'GIT & Renal System',
  5: 'Endocrinology & Reproductive System',
  6: 'Nervous System'
};

function cardTerm_(card) {
  var map = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3 };
  return map[Number(card)] || '';
}

/* ========================= ROUTER ========================= */

function doGet(e) {
  var params = (e && e.parameter) ? e.parameter : {};
  return route_(params);
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { body = {}; }
  return route_(body);
}

function route_(req) {
  try {
    if (!req || req.token !== CONFIG.TOKEN) {
      return json_({ ok: false, error: 'Unauthorized (invalid token)' });
    }
    var data = req.data || {};
    switch (req.action) {
      case 'ping':              return json_({ ok: true, data: 'pong' });
      case 'listStudents':      return json_(listStudents_());
      case 'addStudent':        return json_(addStudent_(data));
      case 'updateStudent':     return json_(updateStudent_(data));
      case 'deleteStudent':     return json_(deleteStudent_(data));
      case 'listPending':       return json_(listSheet_(SHEETS.PENDING.name));
      case 'updatePendingItem': return json_(updatePendingItem_(data));
      case 'reseedPending':     return json_(reseedPending_(data));
      case 'listCardFinals':    return json_(listSheet_(SHEETS.CARDFINALS.name));
      case 'saveCardFinal':     return json_(saveCardFinal_(data));
      case 'deleteCardFinal':   return json_(deleteRowById_(SHEETS.CARDFINALS.name, data.id));
      case 'listTermFinals':    return json_(listSheet_(SHEETS.TERMFINALS.name));
      case 'saveTermFinal':     return json_(saveTermFinal_(data));
      case 'deleteTermFinal':   return json_(deleteRowById_(SHEETS.TERMFINALS.name, data.id));
      case 'listAttendance':    return json_(listSheet_(SHEETS.ATTENDANCE.name));
      case 'saveAttendance':    return json_(saveAttendance_(data));
      default:                  return json_({ ok: false, error: 'Unknown action: ' + req.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ===================== SETUP & SHEET HELPERS ===================== */

/** Run this ONCE from the Apps Script editor (authorise when asked). */
function setup() {
  var ss = getSpreadsheet_();
  Logger.log('Spreadsheet ready : ' + ss.getName());
  Logger.log('Spreadsheet ID    : ' + ss.getId());
  Logger.log('Open the sheet    : ' + ss.getUrl());
}

function getSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = CONFIG.SPREADSHEET_ID || props.getProperty('SPREADSHEET_ID');
  var ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('MBBS Academic Record Sheet (Database)');
    props.setProperty('SPREADSHEET_ID', ss.getId());
  }
  ensureSheets_(ss);
  return ss;
}

function ensureSheets_(ss) {
  Object.keys(SHEETS).forEach(function (k) { ensureSheet_(ss, SHEETS[k]); });
  var first = ss.getSheets()[0];
  if (first.getName() === 'Sheet1' && first.getLastRow() === 0) ss.deleteSheet(first);
}

function ensureSheet_(ss, def) {
  var sh = ss.getSheetByName(def.name);
  if (!sh) sh = ss.insertSheet(def.name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers])
      .setFontWeight('bold').setBackground('#0f3c62').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  }
  return sh;
}

function sheet_(name) {
  return getSpreadsheet_().getSheetByName(name);
}

/** Reads a whole sheet into an array of objects keyed by header names. */
function listSheet_(name) {
  var sh = sheet_(name);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, data: [] };
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var values = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var rows = values.map(function (r) {
    var o = {};
    headers.forEach(function (h, i) { o[String(h)] = r[i]; });
    return o;
  });
  return { ok: true, data: rows };
}

function newId_() { return Utilities.getUuid(); }

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** Returns the 1-based row number whose ID column matches, or -1. */
function findRowById_(sh, id) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2 || !id) return -1;
  var ids = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

/** Row number matching two column conditions, or -1. */
function findRowWhere2_(sh, colA, valA, colB, valB) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return -1;
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var iA = headers.indexOf(colA), iB = headers.indexOf(colB);
  if (iA < 0 || iB < 0) return -1;
  var values = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  for (var r = 0; r < values.length; r++) {
    if (String(values[r][iA]) === String(valA) && String(values[r][iB]) === String(valB)) return r + 2;
  }
  return -1;
}

function getStudent_(studentId) {
  var sh = sheet_(SHEETS.STUDENTS.name);
  var row = findRowById_(sh, studentId);
  if (row < 0) throw new Error('Student not found.');
  var v = sh.getRange(row, 1, 1, 4).getValues()[0];
  return { id: v[0], roll: String(v[1]), name: String(v[2]), year: String(v[3]) };
}

function grade_(pct) {
  if (pct >= 80) return 'A+';
  if (pct >= 70) return 'A';
  if (pct >= 60) return 'A-';
  if (pct >= 50) return 'B';
  if (pct >= 40) return 'C';
  return 'F';
}

function deleteRowById_(sheetName, id) {
  var sh = sheet_(sheetName);
  var row = findRowById_(sh, id);
  if (row < 0) return { ok: false, error: 'Record not found.' };
  sh.deleteRow(row);
  return { ok: true };
}

/** Deletes every row of sheetName whose colName equals value. */
function deleteRowsWhere_(sheetName, colName, value) {
  var sh = sheet_(sheetName);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var col = headers.indexOf(colName);
  if (col < 0) return 0;
  var values = sh.getRange(2, col + 1, lastRow - 1, 1).getValues();
  var count = 0;
  for (var r = values.length - 1; r >= 0; r--) {
    if (String(values[r][0]) === String(value)) { sh.deleteRow(r + 2); count++; }
  }
  return count;
}

/* ========================= STUDENTS ========================= */

function listStudents_() {
  return listSheet_(SHEETS.STUDENTS.name);
}

function addStudent_(d) {
  if (!d.roll || !d.name) return { ok: false, error: 'Roll and Name are required.' };
  var sh = sheet_(SHEETS.STUDENTS.name);
  var lastRow = sh.getLastRow();
  if (lastRow >= 2) {
    var rolls = sh.getRange(2, 2, lastRow - 1, 1).getValues();
    for (var i = 0; i < rolls.length; i++) {
      if (String(rolls[i][0]).trim().toLowerCase() === String(d.roll).trim().toLowerCase()) {
        return { ok: false, error: 'A student with roll "' + d.roll + '" already exists.' };
      }
    }
  }
  var id = newId_();
  var roll = String(d.roll).trim();
  var name = String(d.name).trim();
  sh.appendRow([id, roll, name, d.year || '1st Year', d.session || '', d.status || 'Active', today_()]);
  var seeded = seedPendingItems_(id, roll, name);
  return { ok: true, data: { id: id, seeded: seeded } };
}

/** Creates one PendingItems row per course item (47 rows) for a student. */
function seedPendingItems_(studentId, roll, name) {
  var sh = sheet_(SHEETS.PENDING.name);
  var rows = [];
  ITEM_MASTER.forEach(function (g) {
    for (var n = 1; n <= g.count; n++) {
      rows.push([newId_(), studentId, roll, name, g.term, g.card, g.subject, n,
                 g.subject + ' - Item ' + n, 'Pending', '', '']);
    }
  });
  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
  return rows.length;
}

function updateStudent_(d) {
  var sh = sheet_(SHEETS.STUDENTS.name);
  var row = findRowById_(sh, d.id);
  if (row < 0) return { ok: false, error: 'Student not found.' };
  var cur = sh.getRange(row, 1, 1, 7).getValues()[0];
  var roll = (d.roll !== undefined && d.roll !== '') ? String(d.roll).trim() : String(cur[1]);
  var name = (d.name !== undefined && d.name !== '') ? String(d.name).trim() : String(cur[2]);
  var year = (d.year !== undefined) ? d.year : cur[3];
  var session = (d.session !== undefined) ? d.session : cur[4];
  var status = (d.status !== undefined) ? d.status : cur[5];
  sh.getRange(row, 2, 1, 5).setValues([[roll, name, year, session, status]]);
  cascadeStudentInfo_(d.id, roll, name);
  return { ok: true };
}

/** Keeps Roll/Name in the other 4 sheets in sync with the Students sheet. */
function cascadeStudentInfo_(studentId, roll, name) {
  [SHEETS.PENDING.name, SHEETS.CARDFINALS.name, SHEETS.TERMFINALS.name, SHEETS.ATTENDANCE.name]
    .forEach(function (sheetName) {
      var sh = sheet_(sheetName);
      var lastRow = sh.getLastRow();
      if (lastRow < 2) return;
      var cols = sh.getLastColumn();
      var header = sh.getRange(1, 1, 1, cols).getValues()[0];
      var iSid = header.indexOf('StudentID'), iRoll = header.indexOf('Roll'), iName = header.indexOf('Name');
      if (iSid < 0 || iRoll < 0 || iName < 0) return;
      var values = sh.getRange(2, 1, lastRow - 1, cols).getValues();
      for (var r = 0; r < values.length; r++) {
        if (String(values[r][iSid]) === String(studentId)) {
          if (iName === iRoll + 1) {
            sh.getRange(r + 2, iRoll + 1, 1, 2).setValues([[roll, name]]);
          } else {
            sh.getRange(r + 2, iRoll + 1).setValue(roll);
            sh.getRange(r + 2, iName + 1).setValue(name);
          }
        }
      }
    });
}

function deleteStudent_(d) {
  var sh = sheet_(SHEETS.STUDENTS.name);
  var row = findRowById_(sh, d.id);
  if (row < 0) return { ok: false, error: 'Student not found.' };
  var roll = sh.getRange(row, 2).getValue();
  sh.deleteRow(row);
  var removed = 0;
  [SHEETS.PENDING.name, SHEETS.CARDFINALS.name, SHEETS.TERMFINALS.name, SHEETS.ATTENDANCE.name]
    .forEach(function (sheetName) {
      removed += deleteRowsWhere_(sheetName, 'StudentID', d.id);
    });
  return { ok: true, data: { roll: roll, removed: removed } };
}

/** Creates any missing PendingItems rows for a student (safe to run anytime). */
function reseedPending_(d) {
  if (!d.studentId) return { ok: false, error: 'studentId is required.' };
  var stu = getStudent_(d.studentId);
  var sh = sheet_(SHEETS.PENDING.name);
  var existing = {};
  var lastRow = sh.getLastRow();
  if (lastRow >= 2) {
    var cols = sh.getLastColumn();
    var header = sh.getRange(1, 1, 1, cols).getValues()[0];
    var iSid = header.indexOf('StudentID');
    var iTerm = header.indexOf('Term'), iCard = header.indexOf('Card');
    var iSub = header.indexOf('Subject'), iNo = header.indexOf('ItemNo');
    var vals = sh.getRange(2, 1, lastRow - 1, cols).getValues();
    vals.forEach(function (r) {
      if (String(r[iSid]) === String(d.studentId)) {
        existing[r[iTerm] + '|' + r[iCard] + '|' + r[iSub] + '|' + r[iNo]] = true;
      }
    });
  }
  var rows = [];
  ITEM_MASTER.forEach(function (g) {
    for (var n = 1; n <= g.count; n++) {
      var key = g.term + '|' + g.card + '|' + g.subject + '|' + n;
      if (!existing[key]) {
        rows.push([newId_(), d.studentId, stu.roll, stu.name, g.term, g.card, g.subject, n,
                   g.subject + ' - Item ' + n, 'Pending', '', '']);
      }
    }
  });
  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
  return { ok: true, data: { added: rows.length } };
}

/* ============ PENDING / RESULTS / ATTENDANCE WRITES ============ */

function updatePendingItem_(d) {
  if (!d.id) return { ok: false, error: 'id is required.' };
  var sh = sheet_(SHEETS.PENDING.name);
  var row = findRowById_(sh, d.id);
  if (row < 0) return { ok: false, error: 'Item not found.' };
  var status = (d.status === 'Done' || d.status === 'Exempted') ? d.status : 'Pending';
  var doneDate = (status === 'Done') ? (d.doneDate || today_()) : '';
  sh.getRange(row, 10).setValue(status);    // J : Status
  sh.getRange(row, 11).setValue(doneDate);  // K : DoneDate
  if (d.remarks !== undefined) sh.getRange(row, 12).setValue(d.remarks);  // L : Remarks
  return { ok: true, data: { id: d.id, status: status, doneDate: doneDate } };
}

function saveCardFinal_(d) {
  if (!d.studentId || !d.card) return { ok: false, error: 'studentId and card are required.' };
  var sh = sheet_(SHEETS.CARDFINALS.name);
  var stu = getStudent_(d.studentId);
  var obtained = Number(d.marksObtained) || 0;
  var total = Number(d.marksTotal) || CONFIG.CARD_FULL_MARKS;
  var percentage = total > 0 ? Math.round(obtained / total * 1000) / 10 : 0;
  var row = [newId_(), d.studentId, stu.roll, stu.name, d.term || cardTerm_(d.card), Number(d.card),
             CARD_SUBJECTS[Number(d.card)] || '', d.examDate || '', obtained, total,
             percentage, grade_(percentage), d.remarks || '', today_()];
  var existing = findRowWhere2_(sh, 'StudentID', d.studentId, 'Card', d.card);
  if (existing >= 0) {
    sh.getRange(existing, 1, 1, row.length).setValues([row]);
    return { ok: true, data: { updated: true, percentage: percentage, grade: grade_(percentage) } };
  }
  sh.appendRow(row);
  return { ok: true, data: { added: true, percentage: percentage, grade: grade_(percentage) } };
}

function saveTermFinal_(d) {
  if (!d.studentId || !d.term) return { ok: false, error: 'studentId and term are required.' };
  var sh = sheet_(SHEETS.TERMFINALS.name);
  var stu = getStudent_(d.studentId);
  var w = Number(d.written) || 0, o = Number(d.oral) || 0, p = Number(d.practical) || 0;
  var total = w + o + p;
  var full = CONFIG.TERM_COMPONENTS.WRITTEN + CONFIG.TERM_COMPONENTS.ORAL + CONFIG.TERM_COMPONENTS.PRACTICAL;
  var percentage = full > 0 ? Math.round(total / full * 1000) / 10 : 0;
  var result = percentage >= CONFIG.PASS_PERCENT ? 'Pass' : 'Fail';
  var row = [newId_(), d.studentId, stu.roll, stu.name, d.term, d.examDate || '',
             w, o, p, total, percentage, result, d.remarks || '', today_()];
  var existing = findRowWhere2_(sh, 'StudentID', d.studentId, 'Term', d.term);
  if (existing >= 0) {
    sh.getRange(existing, 1, 1, row.length).setValues([row]);
    return { ok: true, data: { updated: true, total: total, percentage: percentage, result: result } };
  }
  sh.appendRow(row);
  return { ok: true, data: { added: true, total: total, percentage: percentage, result: result } };
}

function saveAttendance_(d) {
  if (!d.studentId || !d.term) return { ok: false, error: 'studentId and term are required.' };
  var sh = sheet_(SHEETS.ATTENDANCE.name);
  var stu = getStudent_(d.studentId);
  var lt = Number(d.lectureTotal) || 0, la = Number(d.lectureAttended) || 0;
  var tt = Number(d.tutorialTotal) || 0, ta = Number(d.tutorialAttended) || 0;
  var pt = Number(d.practicalTotal) || 0, pa = Number(d.practicalAttended) || 0;
  var lp = lt > 0 ? Math.round(la / lt * 1000) / 10 : 0;
  var tp = tt > 0 ? Math.round(ta / tt * 1000) / 10 : 0;
  var pp = pt > 0 ? Math.round(pa / pt * 1000) / 10 : 0;
  var row = [newId_(), d.studentId, stu.roll, stu.name, d.term,
             lt, la, tt, ta, pt, pa, lp, tp, pp, d.remarks || '', today_()];
  var existing = findRowWhere2_(sh, 'StudentID', d.studentId, 'Term', d.term);
  if (existing >= 0) {
    sh.getRange(existing, 1, 1, row.length).setValues([row]);
    return { ok: true, data: { updated: true } };
  }
  sh.appendRow(row);
  return { ok: true, data: { added: true } };
}




