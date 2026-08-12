/**
 * Shift Log — Google Apps Script backend.
 *
 * Bound to a Google Sheet. Keeps a "Log" tab of start/stop events and reports
 * a Monday–Sunday weekly summary. Deployed as a web app; the phone frontend
 * and the NFC tags both talk to it over GET.
 */

var SHEET_NAME = 'Log';
var WEEKLY_SHEET_NAME = 'Weekly';
var HEADERS = ['Timestamp', 'Date', 'Time', 'Task', 'Action', 'Source', 'Note',
               'Verified'];
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
var C_VERIFIED = 7;

var SAFETY_SOURCE = 'auto-safety';
var FLAG_COLOR = '#F7E0C3';        // warm amber, in key with the app's palette

// Bumped when the sheet's headers or formatting rules change, so an existing
// sheet is upgraded once rather than re-checked on every request.
var SCHEMA_VERSION = '2';

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
  ensureSchema_(sheet);
  return sheet;
}

var schemaCheckedThisRun_ = false;

/**
 * Brings an existing sheet up to the current schema: the Verified header, and a
 * conditional-format rule that shades any unverified auto-safety row.
 *
 * The rule is deliberately conditional formatting rather than a painted
 * background, so the shading clears itself the moment the Verified box is
 * ticked — no rewriting of past rows, and nothing to run on a schedule.
 */
function ensureSchema_(sheet) {
  if (schemaCheckedThisRun_) return;
  schemaCheckedThisRun_ = true;

  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('schemaVersion') === SCHEMA_VERSION) return;

  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');

  var flagRange = sheet.getRange(2, 1, sheet.getMaxRows() - 1, HEADERS.length);
  var rule = SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($F2="' + SAFETY_SOURCE + '", $H2<>TRUE)')
      .setBackground(FLAG_COLOR)
      .setRanges([flagRange])
      .build();
  sheet.setConditionalFormatRules([rule]);

  props.setProperty('schemaVersion', SCHEMA_VERSION);
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

/** Duck-typed, so a Date from another realm is still recognised. */
function isDate_(value) {
  return !!value && typeof value.getTime === 'function' &&
      typeof value.getFullYear === 'function' && !isNaN(value.getTime());
}

/**
 * The machine-format Timestamp column. Rows may hold a Date (Sheets converted
 * it) or a string; hand-edited cells are accepted in the forgiving forms a
 * person would actually type:
 *
 *   2026-08-11T16:50:14-07:00   written by the app
 *   2026-08-11T23:50:14.280Z    UTC, written by older versions
 *   2026-08-11 16:50:14         local time, no offset
 *   2026-08-11 16:50            local time, seconds optional
 *   2026-08-11                  local midnight
 *
 * Anything without an explicit offset is read as the project's local time,
 * parsed by hand rather than left to the engine, whose behaviour for
 * offset-less strings varies.
 */
function parseTs_(value) {
  if (isDate_(value)) return value;
  if (value === '' || value === null || value === undefined) return null;

  var s = String(value).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0), 0);
  }

  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Y/M/D from the Date column. Sheets often converts that cell into a real date
 * value, so accept a Date as readily as text like "2026-08-11" or "8/11/2026".
 */
function parseDateCell_(value) {
  if (isDate_(value)) {
    return { y: value.getFullYear(), m: value.getMonth(), d: value.getDate() };
  }
  var s = String(value === null || value === undefined ? '' : value).trim();
  if (!s) return null;

  var iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]) - 1, d: Number(iso[3]) };

  var us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);   // 8/11/2026
  if (us) return { y: Number(us[3]), m: Number(us[1]) - 1, d: Number(us[2]) };

  return null;
}

/**
 * H/M/S from the Time column. A time-only cell comes back as a Date pinned to
 * 1899-12-30, so read its clock fields; otherwise accept "16:50", "16:50:14",
 * or "4:50 PM".
 */
function parseTimeCell_(value) {
  if (isDate_(value)) {
    return { h: value.getHours(), min: value.getMinutes(), s: value.getSeconds() };
  }
  var str = String(value === null || value === undefined ? '' : value).trim();
  if (!str) return { h: 0, min: 0, s: 0 };

  var m = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/);
  if (!m) return null;

  var h = Number(m[1]);
  if (m[4]) {                                   // 12-hour clock
    var pm = /[Pp]/.test(m[4]);
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  return { h: h, min: Number(m[2]), s: Number(m[3] || 0) };
}

/**
 * When a row happened.
 *
 * The readable Date and Time columns win, because those are what a person
 * edits; the machine-format Timestamp is only the fallback for rows where they
 * are missing or unparseable. Editing Time alone therefore does what it looks
 * like it does.
 */
function rowWhen_(row) {
  var day = parseDateCell_(row[C_DATE]);
  if (day) {
    var clock = parseTimeCell_(row[C_TIME]);
    if (clock) return new Date(day.y, day.m, day.d, clock.h, clock.min, clock.s, 0);
  }
  return parseTs_(row[C_TIMESTAMP]);
}

/** Local ISO-8601 with an explicit offset, e.g. 2026-08-11T16:50:14-07:00. */
function isoLocal_(when) {
  var base = Utilities.formatDate(when, tz_(), "yyyy-MM-dd'T'HH:mm:ss");
  var offset = Utilities.formatDate(when, tz_(), 'Z');       // e.g. -0700
  return base + offset.slice(0, 3) + ':' + offset.slice(3);
}

function appendRow_(when, task, action, source, note) {
  var sheet = getSheet_();
  sheet.appendRow([
    isoLocal_(when),
    Utilities.formatDate(when, tz_(), 'yyyy-MM-dd'),
    Utilities.formatDate(when, tz_(), 'HH:mm:ss'),
    task || '',
    action,
    source || '',
    note || '',
    ''
  ]);
  // Give rows that need a human decision something to tick. Ordinary rows keep
  // the column empty so the sheet is not a wall of checkboxes.
  if (source === SAFETY_SOURCE) {
    sheet.getRange(sheet.getLastRow(), C_VERIFIED + 1).insertCheckboxes();
  }
}

/** A ticked Verified box — Sheets stores it as a real boolean. */
function isVerified_(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

/**
 * Rows in chronological order, each paired with its parsed timestamp.
 * Ties keep their sheet order, which matters because an auto-switch writes a
 * stop and the following start at the very same instant.
 */
function sortedRows_() {
  var rows = getRows_();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var when = rowWhen_(rows[i]);
    if (when) out.push({ row: rows[i], when: when, i: i });
  }
  out.sort(function (a, b) {
    return (a.when.getTime() - b.when.getTime()) || (a.i - b.i);
  });
  return out;
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
  var rows = sortedRows_();
  for (var i = rows.length - 1; i >= 0; i--) {
    var action = String(rows[i].row[C_ACTION] || '').toLowerCase();
    if (action === 'stop') return null;
    if (action === 'start') {
      return { task: String(rows[i].row[C_TASK] || ''), startTime: rows[i].when };
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
/**
 * Walk the log once and pair start/stop events into closed intervals.
 *
 * Both the app's weekly summary and the Weekly tab are built from this, so the
 * two can never disagree about what the log says.
 *
 * @return {{intervals: !Array, open: ?Object, flagged: !Array}}
 */
function buildIntervals_() {
  var rows = sortedRows_();
  var intervals = [];
  var flagged = [];
  var open = null;
  var sumMs = 0;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i].row;
    var when = rows[i].when;
    sumMs += when.getTime();
    var action = String(row[C_ACTION] || '').toLowerCase();
    var task = String(row[C_TASK] || '').toLowerCase();
    var source = String(row[C_SOURCE] || '').toLowerCase();

    if (action === 'start') {
      // A start with something already open shouldn't happen, but close it
      // here rather than dropping the interval.
      if (open) intervals.push({ task: open.task, from: open.start, to: when });
      open = { task: task, start: when };
    } else if (action === 'stop') {
      if (open) {
        intervals.push({ task: open.task, from: open.start, to: when });
        open = null;
      }
      if (source === SAFETY_SOURCE && !isVerified_(row[C_VERIFIED])) {
        flagged.push({
          task: task,
          when: when,
          note: String(row[C_NOTE] || AUTO_STOP_NOTE)
        });
      }
    }
  }

  // Cheap fingerprint of the log's shape: the row count catches insertions and
  // deletions, the summed times catch an edit to any single row. Deleting rows
  // does not fire onEdit, so this is what lets the Weekly tab notice.
  var fingerprint = rows.length + ':' + sumMs;

  return {
    intervals: intervals,
    open: open,
    flagged: flagged,
    fingerprint: fingerprint
  };
}

function emptyTotals_() {
  var totals = {};
  for (var t = 0; t < TASKS.length; t++) totals[TASKS[t]] = 0;
  return totals;
}

/** Total each task's hours falling inside [week.start, week.end]. */
function totalsForWeek_(parsed, week, now) {
  var totals = emptyTotals_();

  for (var i = 0; i < parsed.intervals.length; i++) {
    var iv = parsed.intervals[i];
    addHours_(totals, iv.task, iv.from, iv.to, week);
  }
  // A running task contributes its elapsed time so far.
  if (parsed.open && now) {
    addHours_(totals, parsed.open.task, parsed.open.start, now, week);
  }

  var totalHours = 0;
  for (var key in totals) {
    totals[key] = Math.round(totals[key] * 1000) / 1000;
    totalHours += totals[key];
  }
  return { totals: totals, totalHours: Math.round(totalHours * 1000) / 1000 };
}

/**
 * Pair start/stop events per task and total the hours falling inside the
 * current Mon–Sun week. A running task contributes its elapsed time so far.
 */
function getSummary() {
  var now = new Date();
  var week = getWeekBounds(now);
  var parsed = buildIntervals_();
  var summed = totalsForWeek_(parsed, week, now);

  syncWeekly_(parsed);

  var flagged = [];
  for (var i = 0; i < parsed.flagged.length; i++) {
    var f = parsed.flagged[i];
    if (f.when.getTime() >= week.start.getTime() &&
        f.when.getTime() <= week.end.getTime()) {
      flagged.push({ task: f.task, time: f.when.toISOString(), note: f.note });
    }
  }

  return {
    status: 'ok',
    weekStart: week.start.toISOString(),
    weekEnd: week.end.toISOString(),
    totals: summed.totals,
    totalHours: summed.totalHours,
    active: parsed.open
        ? { task: parsed.open.task, startTime: parsed.open.start.toISOString() }
        : null,
    flagged: flagged
  };
}

function addHours_(totals, task, from, to, week) {
  if (!task || !(task in totals)) return;
  totals[task] += overlapHours_(from, to, week.start, week.end);
}

/* ------------------------------------------------------------------ *
 * Weekly tab
 * ------------------------------------------------------------------ */

/** The Monday 00:00 that starts the week containing `date`, as a key. */
function weekKey_(date) {
  return Utilities.formatDate(getWeekBounds(date).start, tz_(), 'yyyy-MM-dd');
}

/**
 * Split an interval across every Mon–Sun week it touches, so a session running
 * past Sunday midnight lands partly in each week rather than wholly in one.
 */
function addIntervalToWeeks_(byWeek, task, from, to) {
  if (!task || TASKS.indexOf(task) === -1) return;
  if (to.getTime() <= from.getTime()) return;

  var cursor = new Date(from.getTime());
  var guard = 0;
  while (cursor.getTime() < to.getTime() && guard++ < 520) {   // ~10 years
    var week = getWeekBounds(cursor);
    var key = Utilities.formatDate(week.start, tz_(), 'yyyy-MM-dd');
    if (!byWeek[key]) byWeek[key] = emptyTotals_();
    byWeek[key][task] += overlapHours_(from, to, week.start, week.end);

    // Step into the following week.
    cursor = new Date(week.end.getTime() + 1);
  }
}

/**
 * Rebuild the read-only "Weekly" tab: one row per week, newest first.
 *
 * Recomputed from the log rather than accumulated, so hand-corrections to past
 * rows are reflected the next time it runs and the tab can never drift.
 */
function rebuildWeekly_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(WEEKLY_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(WEEKLY_SHEET_NAME);

  var parsed = buildIntervals_();
  var now = new Date();
  var byWeek = {};

  for (var i = 0; i < parsed.intervals.length; i++) {
    var iv = parsed.intervals[i];
    addIntervalToWeeks_(byWeek, iv.task, iv.from, iv.to);
  }
  if (parsed.open) {
    addIntervalToWeeks_(byWeek, parsed.open.task, parsed.open.start, now);
  }

  var keys = Object.keys(byWeek).sort().reverse();          // newest week first
  var header = ['Week of (Mon)'];
  for (var t = 0; t < TASKS.length; t++) {
    header.push(TASKS[t].charAt(0).toUpperCase() + TASKS[t].slice(1));
  }
  header.push('Total');

  var out = [header];
  for (var k = 0; k < keys.length; k++) {
    var totals = byWeek[keys[k]];
    var line = [keys[k]];
    var sum = 0;
    for (var n = 0; n < TASKS.length; n++) {
      var hours = Math.round(totals[TASKS[n]] * 100) / 100;
      line.push(hours);
      sum += hours;
    }
    line.push(Math.round(sum * 100) / 100);
    out.push(line);
  }

  sheet.clear();
  sheet.getRange(1, 1, out.length, header.length).setValues(out);
  sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  if (out.length > 1) {
    sheet.getRange(2, 2, out.length - 1, header.length - 1)
        .setNumberFormat('0.00');
  }
  return out.length - 1;
}

/**
 * Rebuild the Weekly tab only when the log has actually changed since the last
 * rebuild. Every read of the summary passes through here, so a change made in
 * ways that fire no trigger — deleting rows, an import, an edit from another
 * device — is picked up the next time the app refreshes.
 *
 * Rebuilding is a write, so gating it on the fingerprint is what keeps an
 * ordinary 60-second refresh from writing to the sheet every time.
 */
function syncWeekly_(parsed) {
  try {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('weeklyFingerprint') === parsed.fingerprint) return;
    rebuildWeekly_();
    props.setProperty('weeklyFingerprint', parsed.fingerprint);
  } catch (err) {
    // The rollup is a convenience; never fail a request over it.
  }
}

/**
 * Simple trigger: keep the Weekly tab honest after a hand-correction in the
 * Log. Failures are swallowed so a bad edit can never block editing.
 */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    if (e.range.getSheet().getName() !== SHEET_NAME) return;
    rebuildWeekly_();
    PropertiesService.getScriptProperties()
        .setProperty('weeklyFingerprint', buildIntervals_().fingerprint);
  } catch (err) {
    // Nothing useful to do from a simple trigger.
  }
}
