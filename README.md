# 🩺 MBBS Academic Record Sheet — 1st & 2nd Year (Physiology)

A complete academic record system for a Physiology department.

| Module | What it records |
|---|---|
| **Students** | Roll, name, year (1st/2nd), session/batch |
| **Pending items** | All 47 card items per student (Done / Pending / Exempted) with completion dates |
| **Card final** | Marks of Card 1–6 final exams with auto % and grade |
| **Term final** | Written + Oral + Practical marks per term with total, % and Pass/Fail |
| **Attendance** | Lecture, Tutorial & Practical classes attended/total for each of the 3 terms, with % (warns below 75%) |

**Course structure (Physiology, 1st professional year):**

- **1st Term** — Card 1: Cellular Physiology (5 items) + Blood Physiology (5 items) · Card 2: Cardiovascular System (6 items)
- **2nd Term** — Card 3: Respiratory System (5 items) · Card 4: GIT & Renal System (7 items)
- **3rd Term** — Card 5: Endocrinology & Reproductive System (9 items) · Card 6: Nervous System (10 items)

Total: **6 cards, 47 items**, auto-seeded for every student.

**Architecture**

```
Browser (HTML/CSS/JS)  →  Node.js server (server.js, port 3000)  →  Google Apps Script Web App (Code.gs)  →  Google Sheet (database)
```

- `public/` — the frontend (index.html, css/style.css, js/app.js)
- `server.js` — Node.js backend, **no npm packages required** (plain Node only)
- `config.js` — web-server settings (Apps Script URL + shared token)
- `apps-script/Code.gs` — paste into your Apps Script project; it creates and manages all sheets

---

## Setup (one time, ~10 minutes)

### Step 1 — Apps Script (the Google Sheet "brain")

1. Open your Apps Script project:
   `https://script.google.com/u/0/home/projects/1FdUPy6ti1Mh0G8r5Xcvot3PzD7b_0exuZesDOcgBiuHesQ_PxrERQAZA/edit`
2. Delete any code in the editor and paste the **entire contents** of `apps-script/Code.gs`.
3. Check `CONFIG.TOKEN` = `mbbs-record-2026` (must match `config.js`).
   Leave `CONFIG.SPREADSHEET_ID` empty → a Google Sheet named *"MBBS Academic Record Sheet (Database)"* is created automatically on first run.
4. In the toolbar select the function **`setup`** and click **Run**. Authorise when asked.
   The execution log shows the spreadsheet URL and ID.
5. Click **Deploy ▸ New deployment ▸ (⚙) Web app** and set:
   - Description: `MBBS record sheet API`
   - **Execute as: Me**
   - **Who has access: Anyone**  ← important, otherwise the Node server cannot call it
6. Click **Deploy** and copy the **Web App URL** (ends with `/exec`).

### Step 2 — Configure and start the Node.js server

6. Open `config.js` and paste the Web App URL from Step 1.6 into `APPS_SCRIPT_URL`.
   Make sure the `TOKEN` value equals `CONFIG.TOKEN` in Code.gs.
7. In this folder open a terminal and run:

   ```
   node server.js
   ```

   (No `npm install` needed — the server has zero dependencies. You only need Node.js 14+ installed: https://nodejs.org)
8. Open **http://localhost:3000** — the status dot turns green: *connected to Google Sheet*.

---

## Sign-in (login) gate

The app is protected by a login screen. Sign in with:

| Field | Value |
|---|---|
| **ID** | `Academic Record of students` |
| **Password** | `Universal2026##` |

- The credentials are verified by the **Node server** (`POST /api/login`) — not just in the browser — and every data endpoint (`/api/students`, `/api/pending`, …) rejects requests without a valid session token, so the data cannot be reached without signing in.
- A session lasts **12 hours** (per browser tab) or until you press **Sign out**; restarting the Node server ends all sessions and everyone signs in again.
- After **8 failed attempts from one IP within 15 minutes** further attempts are blocked for a few minutes.
- To change the credentials edit `LOGIN_ID` / `LOGIN_PASSWORD` in `config.js` (or set the `LOGIN_ID` / `LOGIN_PASSWORD` environment variables) and restart the server.

---

## How to use

0. **Sign in** — open the app and enter the ID + password (see *Sign-in gate* above).
1. **Students tab** — add students (roll, name, year, session). Every new student automatically gets all **47 items** seeded as *Pending*.
2. **Pending Items tab** — pick a student; click any item chip to cycle **Pending → Done → Exempted → Pending** ("Done" stamps today's date). Progress bars show card/term completion. *Re-seed* adds any missing item rows.
3. **Card Final tab** — pick a student, enter exam date, marks obtained and full marks (default 100) per card; % and grade (A+ … F) are calculated on save. Saving again for the same card **updates** the existing result.
4. **Term Final tab** — enter written (max 100), oral / viva (max 100), practical (max 100) per term; total, % and Pass (≥ 60%) are calculated automatically.
5. **Attendance tab** — per term, enter attended/total for Lecture, Tutorial and Practical classes; percentages are calculated and turn red below 75%.
6. **Dashboard** — overview counters, students with pending items, and attendance alerts below 75%.

## Google Sheets database (5 tabs, created automatically)

| Tab | Columns |
|---|---|
| Students | ID, Roll, Name, Year, Session, Status, CreatedAt |
| PendingItems | ID, StudentID, Roll, Name, Term, Card, Subject, ItemNo, ItemLabel, Status, DoneDate, Remarks |
| CardFinals | ID, StudentID, Roll, Name, Term, Card, Subject, ExamDate, MarksObtained, MarksTotal, Percentage, Grade, Remarks, UpdatedAt |
| TermFinals | ID, StudentID, Roll, Name, Term, ExamDate, Written, Oral, Practical, Total, Percentage, Result, Remarks, UpdatedAt |
| Attendance | ID, StudentID, Roll, Name, Term, LectureTotal, LectureAttended, TutorialTotal, TutorialAttended, PracticalTotal, PracticalAttended, LecturePercent, TutorialPercent, PracticalPercent, Remarks, UpdatedAt |

You can open the Google Sheet directly to view/print the raw record — the app reads and writes it live.

## Customisation

- **Item counts / subjects** → `ITEM_MASTER` in `apps-script/Code.gs` **and** `public/js/app.js` (keep both identical). Redeploy the Apps Script as a *new version*, then reload the app.
- **Full marks / pass mark / attendance warning** → `CONFIG` in `Code.gs` and the constants at the top of `public/js/app.js`.
- **Port / token** → `config.js` (and `CONFIG.TOKEN` in Code.gs if you change the token).

## Troubleshooting

| Problem | Fix |
|---|---|
| Status dot stays red / "APPS_SCRIPT_URL is not set" | Paste the Web App URL into `config.js` and restart `node server.js`. |
| "Unexpected reply from Apps Script" (HTML received) | Re-deploy the web app with **Who has access: Anyone**; the URL must end with `/exec`, not `/dev`. |
| "Unauthorized (invalid token)" | `TOKEN` in `config.js` must equal `CONFIG.TOKEN` in Code.gs. Redeploy a **new version** after changing Code.gs. |
| Edited Code.gs but nothing changed | Deploy ▸ Manage deployments ▸ ✏ ▸ Version: **New version** ▸ Deploy. |
| A student is missing item rows | Pending Items tab → **Re-seed missing items**. |

## Notes

- The **Year** field (1st/2nd year) identifies the batch. The 6-card / 3-term structure above applies to every student — a "2nd Year" student here is typically a repeating / professional-exam student of the same Physiology course. If you ever need a different structure for a separate 2nd-year course, extend `ITEM_MASTER` in both files.
- The shared token is a light guard that stops strangers from writing to your sheet. For stricter control, restrict the deployment to specific Google accounts.

## Offline backend test (optional but recommended)

`dev-test/gas-mock-test.js` simulates the Google Apps Script environment in memory and runs the **real** `Code.gs` through 55 end-to-end checks (database creation, token security, 47-item seeding, marking items, card/term final upserts with auto %/grade, attendance %, cascade update/delete, validation errors):

```
node dev-test/gas-mock-test.js
```

Expected output ends with `RESULT: 55 passed, 0 failed`.


