/**
 * Central configuration for the Node.js server.
 * ------------------------------------------------
 *  1) APPS_SCRIPT_URL : paste your Apps Script "Web app" URL here
 *     (the one that ends with /exec). See README.md → Setup steps 3-5.
 *  2) TOKEN           : must be EXACTLY the same as CONFIG.TOKEN
 *     inside apps-script/Code.gs (it acts as a shared password).
 *  3) PORT            : local web-server port (default 3000).
 * ------------------------------------------------
 */
module.exports = {
  PORT: process.env.PORT || 3000,

  // ⬇⬇ PASTE YOUR APPS SCRIPT WEB APP URL HERE, e.g.
  // 'https://script.google.com/macros/s/AKfycb.../exec'
  APPS_SCRIPT_URL: process.env.APPS_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbzPXUF9BtolySb-BcqG1bJ7HcJS8AXZ8nUWK3QFZgfwwG3YHdjNbEf5IM_SBhGVpYv6TA/exec',

  // Shared secret between Node.js and Google Apps Script (keep them identical)
  TOKEN: process.env.APPS_SCRIPT_TOKEN || 'mbbs-record-2026',

  // ---- Sign-in gate (login screen) ----
  // Users must enter this ID + password to open the app.
  // Override with the LOGIN_ID / LOGIN_PASSWORD environment variables.
  LOGIN_ID: process.env.LOGIN_ID || 'Academic Record of students',
  LOGIN_PASSWORD: process.env.LOGIN_PASSWORD || 'Universal2026##',
};
