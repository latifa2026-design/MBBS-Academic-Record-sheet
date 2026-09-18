/**
 * =====================================================================
 *  MBBS ACADEMIC RECORD SHEET — Node.js backend
 *  ---------------------------------------------------------------------
 *  • Serves the HTML/CSS/JS frontend from the /public folder
 *  • Proxies every API call to the Google Apps Script Web App
 *    (apps-script/Code.gs), which stores all data in a Google Sheet.
 *
 *  NO EXTERNAL DEPENDENCIES — runs with plain Node.js:
 *        node server.js        (or: npm start)
 *  Then open  http://localhost:3000
 *
 *  Before starting, put your Apps Script Web App URL into config.js.
 * =====================================================================
 */

'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* API routes → Apps Script actions */
const READ_ACTIONS = {
  '/api/students': 'listStudents',
  '/api/pending': 'listPending',
  '/api/cardfinals': 'listCardFinals',
  '/api/termfinals': 'listTermFinals',
  '/api/attendance': 'listAttendance',
};

const WRITE_ACTIONS = {
  '/api/students': 'addStudent',
  '/api/students/update': 'updateStudent',
  '/api/students/delete': 'deleteStudent',
  '/api/pending/update': 'updatePendingItem',
  '/api/pending/reseed': 'reseedPending',
  '/api/cardfinals': 'saveCardFinal',
  '/api/cardfinals/delete': 'deleteCardFinal',
  '/api/termfinals': 'saveTermFinal',
  '/api/termfinals/delete': 'deleteTermFinal',
  '/api/attendance': 'saveAttendance',
};

/* ------------------------------------------------------------------ */
/*  Google Apps Script client                                         */
/* ------------------------------------------------------------------ */

function isConfigured() {
  return !!config.APPS_SCRIPT_URL && !config.APPS_SCRIPT_URL.includes('PASTE_');
}

/*
 * Google Apps Script web apps always answer with an HTTP 302 redirect to
 * script.googleusercontent.com/macros/echo?user_content_key=... , which then
 * returns the actual JSON. Node's https module does NOT follow redirects,
 * so we follow the chain ourselves (POST → 302 → GET, up to 5 hops).
 */
function httpsFollow_(urlObj, method, body, hops) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(body, 'utf8');
    const headers = {
      // Google throttles header-less automated requests; look like a browser
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MBBS-RecordSheet/1.0',
      'Accept': 'application/json, text/plain, */*',
    };
    if (data) {
      headers['Content-Type'] = 'text/plain;charset=utf-8';
      headers['Content-Length'] = data.length;
    }
    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method,
        headers,
      },
      (res) => {
        const loc = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
          if (hops >= 5) {
            res.resume();
            return reject(new Error('Too many redirects from Apps Script.'));
          }
          res.resume();                                  // drain the empty body
          const next = new URL(loc, urlObj);
          // Standard 302/303 behaviour: a POST redirect continues as GET.
          // 307/308 preserve the original method and body.
          const keepMethod = res.statusCode === 307 || res.statusCode === 308;
          const nextMethod = keepMethod ? method : 'GET';
          const nextBody = keepMethod ? body : null;
          httpsFollow_(next, nextMethod, nextBody, hops + 1).then(resolve, reject);
          return;
        }
        let reply = '';
        res.on('data', (c) => (reply += c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: reply }));
      }
    );
    req.on('error', (e) => reject(new Error('Cannot reach Apps Script: ' + e.message)));
    req.setTimeout(25000, () => req.destroy(new Error('Apps Script request timed out')));
    if (data) req.write(data);
    req.end();
  });
}

async function callAppsScript(payload) {
  if (!isConfigured()) {
    return Promise.reject(new Error('APPS_SCRIPT_URL is not set. Open config.js and paste your Apps Script Web App URL (see README.md).'));
  }
  let url;
  try { url = new URL(config.APPS_SCRIPT_URL); }
  catch (e) { return Promise.reject(new Error('APPS_SCRIPT_URL in config.js is not a valid URL.')); }

  /*
   * Google's echo endpoint occasionally hiccups (HTTP 500 or an HTML error
   * page) when calls arrive in rapid succession. Retry up to 3 times with a
   * short delay — every retry gets a fresh redirect user_content_key.
   */
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
    let fatal = null;
    try {
      const { statusCode, body } = await httpsFollow_(url, 'POST', JSON.stringify(payload), 0);
      let out = null;
      try { out = JSON.parse(body); } catch (e) { /* not JSON (e.g. HTML error page) */ }
      if (out && out.ok !== false) return out;                      // success
      const msg = (out && out.error)
        ? String(out.error)
        : 'Unexpected reply from Apps Script (HTTP ' + statusCode + '). ' +
          'Check the deployment (Who has access: Anyone). Reply starts with: ' + body.slice(0, 160);
      /*
       * Google's echo endpoint intermittently replies with a spurious
       * "Unauthorized (invalid token)" or an HTML page when calls arrive in
       * rapid succession -> transient, retry. Any other Apps Script error is
       * surfaced immediately.
       */
      if (!out || /invalid token|unauthorized/i.test(msg)) {
        lastErr = new Error(msg);                                   // transient
      } else {
        fatal = new Error(msg);
      }
    } catch (err) {
      if (err && err.fatal) throw err;
      lastErr = err;                                                // network hiccup: retry
    }
    if (fatal) throw fatal;
  }
  throw (lastErr || new Error('Apps Script call failed after retries'));
}

/* ------------------------------------------------------------------ */
/*  Sign-in gate (login screen)                                       */
/* ------------------------------------------------------------------ */

/*
 * Credentials come from config.js (LOGIN_ID / LOGIN_PASSWORD) and can be
 * overridden with the LOGIN_ID / LOGIN_PASSWORD environment variables.
 * Sessions are kept in memory: after a server restart (or SESSION_HOURS
 * after sign-in) every client must sign in again.
 */
const SESSION_HOURS = 12;
const LOGIN_MAX_FAILS = 8;                    // failed attempts per IP …
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;  // … within this window

const sessions = new Map();   // token -> expiresAt (ms)
const loginFails = new Map(); // ip -> { count, first }

function safeEqual_(a, b) {
  /* Hash both sides to a fixed length before comparing — timingSafeEqual
     throws on unequal lengths, which would leak whether the ID or the
     password had the wrong length. */
  const ha = crypto.createHash('sha256').update(String(a == null ? '' : a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b == null ? '' : b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sessionToken_(req) {
  return String(req.headers['x-auth-token'] || '');
}

function validSession_(req) {
  const tok = sessionToken_(req);
  if (!tok) return false;
  const exp = sessions.get(tok);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(tok); return false; }
  return true;
}

function pruneLoginFails_(now) {
  loginFails.forEach((v, ip) => {
    if (now - v.first > LOGIN_FAIL_WINDOW_MS) loginFails.delete(ip);
  });
}

async function handleLogin(req, res) {
  const ip = (req.socket && req.socket.remoteAddress) || '?';
  const now = Date.now();
  pruneLoginFails_(now);
  const fails = loginFails.get(ip);
  if (fails && fails.count >= LOGIN_MAX_FAILS) {
    const waitMin = Math.max(1, Math.ceil((LOGIN_FAIL_WINDOW_MS - (now - fails.first)) / 60000));
    return sendJson(res, 429, { ok: false, error: 'Too many failed attempts. Try again in about ' + waitMin + ' minute(s).' });
  }
  const body = await readBody(req);
  const id = String(body.id || '').trim();
  const password = String(body.password || '');
  if (safeEqual_(id, config.LOGIN_ID) && safeEqual_(password, config.LOGIN_PASSWORD)) {
    loginFails.delete(ip);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, now + SESSION_HOURS * 3600 * 1000);
    console.log('[auth] sign-in OK from ' + ip);
    return sendJson(res, 200, { ok: true, data: { token: token, expiresInHours: SESSION_HOURS } });
  }
  const rec = fails || { count: 0, first: now };
  rec.count += 1;
  loginFails.set(ip, rec);
  console.log('[auth] failed sign-in (' + rec.count + ') from ' + ip);
  return sendJson(res, 401, { ok: false, error: 'Wrong ID or password.' });
}

/* ------------------------------------------------------------------ */
/*  Small HTTP helpers                                                */
/* ------------------------------------------------------------------ */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',   // never cache API replies — a deleted row must vanish at once
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/*  API handler                                                       */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, configured: isConfigured(), node: process.version });
  }

  /* ---- sign-in gate: everything below requires a valid session ---- */
  if (pathname === '/api/login') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST required' });
    try { return await handleLogin(req, res); }
    catch (err) { return sendJson(res, 500, { ok: false, error: err.message }); }
  }
  if (pathname === '/api/logout') {
    const tok = sessionToken_(req);
    if (tok) sessions.delete(tok);
    return sendJson(res, 200, { ok: true, data: { signedOut: true } });
  }
  if (!validSession_(req)) {
    return sendJson(res, 401, { ok: false, error: 'Please sign in to continue.' });
  }

  if (req.method === 'GET' && READ_ACTIONS[pathname]) {
    try {
      const out = await callAppsScript({ action: READ_ACTIONS[pathname], token: config.TOKEN });
      return sendJson(res, 200, out);
    } catch (err) {
      console.error('[api] GET ' + pathname + ' failed: ' + err.message);
      return sendJson(res, 502, { ok: false, error: err.message });
    }
  }

  if (req.method === 'POST' && WRITE_ACTIONS[pathname]) {
    const body = await readBody(req);
    try {
      const out = await callAppsScript({ action: WRITE_ACTIONS[pathname], token: config.TOKEN, data: body || {} });
      return sendJson(res, 200, out);
    } catch (err) {
      console.error('[api] POST ' + pathname + ' failed: ' + err.message);
      return sendJson(res, 502, { ok: false, error: err.message });
    }
  }

  sendJson(res, 404, { ok: false, error: 'Unknown API route: ' + pathname });
}

/* ------------------------------------------------------------------ */
/*  Static file server (frontend in /public)                          */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    return res.end('Method not allowed');
  }
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {           // block path traversal
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 - Not found: ' + rel);
    }
    const ext = path.extname(filePath).toLowerCase();
    /* Always revalidate: with no cache headers a browser may heuristically
       cache a stale app.js / index.html and keep running old frontend code
       (e.g. a delete button that no longer matches the backend). */
    let etag = '';
    try {
      etag = '"' + buf.length.toString(16) + '-' + Math.floor(fs.statSync(filePath).mtimeMs).toString(16) + '"';
    } catch (e) { /* stat failed — serve without ETag */ }
    if (etag && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    };
    if (etag) headers.ETag = etag;
    res.writeHead(200, headers);
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ */
/*  Server                                                            */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
  } else {
    serveStatic(req, res, pathname);
  }
});

server.listen(config.PORT, () => {
  console.log('==========================================================');
  console.log('   MBBS ACADEMIC RECORD SHEET - Physiology Dept.');
  console.log('   Open the app:        http://localhost:' + config.PORT);
  console.log('   Apps Script URL:     ' + (isConfigured() ? config.APPS_SCRIPT_URL : 'NOT CONFIGURED - edit config.js'));
  console.log('   Sign-in ID:          ' + config.LOGIN_ID);
  console.log('   Stop the server:     Ctrl + C');
  console.log('==========================================================');
});

