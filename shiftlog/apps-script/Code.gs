/**
 * Shift Log — Google Apps Script backend.
 *
 * Bound to a Google Sheet. Keeps a "Log" tab of start/stop events and reports
 * a Monday–Sunday weekly summary. Deployed as a web app; the phone frontend
 * and the NFC tags both talk to it over GET.
 */

var SHEET_NAME = 'Log';
var HEADERS = ['Timestamp', 'Date', 'Time', 'Task', 'Action', 'Source', 'Note'];
var TASKS = ['clinic', 'lunch', 'notes', 'inbox', 'forms', 'meeting'];
var AUTO_STOP_HOURS = 6;

// Column indexes into a row array.
var C_TIMESTAMP = 0;
var C_DATE = 1;
var C_TIME = 2;
var C_TASK = 3;
var C_ACTION = 4;
var C_SOURCE = 5;
var C_NOTE = 6;

var AUTO_STOP_NOTE = 'Auto-stopped after ' + AUTO_STOP_HOURS +
    'h — review, may be inaccurate.';

/* ------------------------------------------------------------------ *
 * Web app entry points
 * ------------------------------------------------------------------ */

function doGet(e) {
  try {
    checkAutoStop();
    var p = (e && e.parameter) || {};
    if (p.action) {
      return jsonOut_(logEvent(p.task, p.action, p.source || 'link', p.note || ''));
    }
    return jsonOut_(getSummary());
  } catch (err) {
    return jsonOut_({ status: 'error', message: errText_(err) });
  }
}

function doPost(e) {
  try {
    checkAutoStop();
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents) || {};
    }
    if (body.action) {
      return jsonOut_(logEvent(body.task, body.action, body.source || 'link',
          body.note || ''));
    }
    return jsonOut_(getSummary());
  } catch (err) {
    return jsonOut_({ status: 'error', message: errText_(err) });
  }
}

function jsonOut_(obj) {
  return ContentService
      .createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
}

function errText_(err) {
  return String((err && err.message) ? err.message : err);
}

/* ------------------------------------------------------------------ *
 * Sheet access
 * ------------------------------------------------------------------ */

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    // Keep timestamps/dates/times as literal text so Sheets does not
    // reinterpret them into its own locale formatting.
    sheet.getRange(1, 1, sheet.getMaxRows(), 3).setNumberFormat('@');
  }
  return sheet;
}

/** All data rows (header excluded), oldest first. */
function getRows_() {
  var sheet = getSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
}

function tz_() {
  return Session.getScriptTimeZone();
}

/** Rows may hold a string or a Date depending on how Sheets stored them. */
function parseTs_(value) {
  if (value instanceof Date) return value;
  if (value === '' || value === null || value === undefined) return null;
  var d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function appendRow_(when, task, action, source, note) {
  var sheet = getSheet_();
  sheet.appendRow([
    when.toISOString(),
    Utilities.formatDate(when, tz_(), 'yyyy-MM-dd'),
    Utilities.formatDate(when, tz_(), 'HH:mm:ss'),
    task || '',
    action,
    source || '',
    note || ''
  ]);
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/**
 * The most recent unmatched 'start', scanning bottom-up. Every 'start' is
 * preceded by a 'stop' for whatever was running, so the last event row alone
 * decides whether something is running.
 * @return {?{task: string, startTime: Date}}
 */
function getActiveTask() {
  var rows = getRows_();
  for (var i = rows.length - 1; i >= 0; i--) {
    var action = String(rows[i][C_ACTION] || '').toLowerCase();
    if (action === 'stop') return null;
    if (action === 'start') {
      var started = parseTs_(rows[i][C_TIMESTAMP]);
      if (!started) return null;
      return { task: String(rows[i][C_TASK] || ''), startTime: started };
    }
  }
  return null;
}

/**
 * Record a start/stop. Starting a task stops whatever else was running.
 * @return {!Object} the fresh summary payload.
 */
function logEvent(task, action, source, note) {
  action = String(action || '').toLowerCase();
  task = String(task || '').toLowerCase();

  if (action !== 'start' && action !== 'stop') {
    return { status: 'error', message: 'Unknown action: ' + action };
  }
  if (action === 'start' && TASKS.indexOf(task) === -1) {
    return { status: 'error', message: 'Unknown task: ' + task };
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    return { status: 'error', message: 'Busy, please retry.' };
  }

  try {
    var now = new Date();
    var active = getActiveTask();

    if (action === 'start') {
      if (active && active.task === task) {
        return getSummary();  // already running; nothing to record
      }
      if (active) {
        appendRow_(now, active.task, 'stop', 'auto-switch',
            'Stopped automatically because ' + task + ' was started.');
      }
      appendRow_(now, task, 'start', source, note);
    } else {
      var target = active ? active.task : task;
      if (target) {
        appendRow_(now, target, 'stop', source, note);
      }
      // Nothing running and no task named: nothing to stop.
    }

    return getSummary();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Safety net: a task left running past AUTO_STOP_HOURS is stopped and flagged
 * for review, since the real stop almost certainly happened earlier.
 */
function checkAutoStop() {
  var active = getActiveTask();
  if (!active) return;

  var elapsedHours = (new Date().getTime() - active.startTime.getTime()) / 3600000;
  if (elapsedHours < AUTO_STOP_HOURS) return;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    return;
  }
  try {
    // Re-check under the lock in case another request just handled it.
    var stillActive = getActiveTask();
    if (!stillActive) return;
    if ((new Date().getTime() - stillActive.startTime.getTime()) / 3600000 <
        AUTO_STOP_HOURS) {
      return;
    }
    appendRow_(new Date(), stillActive.task, 'stop', 'auto-safety',
        AUTO_STOP_NOTE);
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ *
 * Weekly summary
 * ------------------------------------------------------------------ */

/** Monday 00:00:00.000 through Sunday 23:59:59.999, local time. */
function getWeekBounds(date) {
  var d = date ? new Date(date.getTime()) : new Date();
  var dayOfWeek = d.getDay();                      // 0 = Sunday
  var sinceMonday = (dayOfWeek === 0) ? 6 : dayOfWeek - 1;

  var start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceMonday,
      0, 0, 0, 0);
  var end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6,
      23, 59, 59, 999);
  return { start: start, end: end };
}

/** Hours of [from, to] that land inside [weekStart, weekEnd]. */
function overlapHours_(from, to, weekStart, weekEnd) {
  var a = Math.max(from.getTime(), weekStart.getTime());
  var b = Math.min(to.getTime(), weekEnd.getTime());
  return b > a ? (b - a) / 3600000 : 0;
}

/**
 * Pair start/stop events per task and total the hours falling inside the
 * current Mon–Sun week. A running task contributes its elapsed time so far.
 */
function getSummary() {
  var now = new Date();
  var week = getWeekBounds(now);

  var totals = {};
  for (var t = 0; t < TASKS.length; t++) totals[TASKS[t]] = 0;

  var flagged = [];
  var rows = getRows_();
  var open = null;   // {task, start}

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var when = parseTs_(row[C_TIMESTAMP]);
    if (!when) continue;

    var action = String(row[C_ACTION] || '').toLowerCase();
    var task = String(row[C_TASK] || '').toLowerCase();
    var source = String(row[C_SOURCE] || '').toLowerCase();

    if (action === 'start') {
      // A start with something already open shouldn't happen, but close it
      // here rather than dropping the interval.
      if (open) addHours_(totals, open.task, open.start, when, week);
      open = { task: task, start: when };
    } else if (action === 'stop') {
      if (open) {
        addHours_(totals, open.task, open.start, when, week);
        open = null;
      }
      if (source === 'auto-safety' &&
          when.getTime() >= week.start.getTime() &&
          when.getTime() <= week.end.getTime()) {
        flagged.push({
          task: task,
          time: when.toISOString(),
          note: String(row[C_NOTE] || AUTO_STOP_NOTE)
        });
      }
    }
  }

  var active = null;
  if (open) {
    addHours_(totals, open.task, open.start, now, week);
    active = { task: open.task, startTime: open.start.toISOString() };
  }

  var totalHours = 0;
  for (var key in totals) {
    totals[key] = Math.round(totals[key] * 1000) / 1000;
    totalHours += totals[key];
  }

  return {
    status: 'ok',
    weekStart: week.start.toISOString(),
    weekEnd: week.end.toISOString(),
    totals: totals,
    totalHours: Math.round(totalHours * 1000) / 1000,
    active: active,
    flagged: flagged
  };
}

function addHours_(totals, task, from, to, week) {
  if (!task || !(task in totals)) return;
  totals[task] += overlapHours_(from, to, week.start, week.end);
}
