// Harness: run Code.gs against a fake Sheets/Apps Script environment.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'apps-script', 'Code.gs');

function makeEnv() {
  const rows = [];       // data rows only
  let header = null;

  const checkboxCells = [];        // [row, col] pairs given a checkbox
  const displayOverrides = {};     // "rowIndex:colIndex" -> text Sheets would show
  let formatRules = [];

  const sheet = {
    getName: () => 'Log',
    getParent: () => ss,
    getLastRow: () => (header ? rows.length + 1 : 0),
    getMaxRows: () => 1000,
    setFrozenRows: () => {},
    getRange: (r, c, nr, nc) => {
      // r is 1-based and includes the header, so data row i sits at r = i + 2.
      const slice = () => rows.slice(r - 2, r - 2 + nr);
      const range = {
        setValues: (v) => { if (r === 1) header = v[0]; return range; },
        setFontWeight: () => range,
        setNumberFormat: () => range,
        insertCheckboxes: () => { checkboxCells.push([r, c]); return range; },
        getValues: () => slice().map((x) => x.slice(c - 1, c - 1 + nc)),
        // What Sheets would render on screen: the override if one is set for
        // this cell, otherwise the value stringified.
        getDisplayValues: () => slice().map((x, k) => {
          const rowIdx = r - 2 + k;
          return x.slice(c - 1, c - 1 + nc).map((cell, j) => {
            const key = `${rowIdx}:${c - 1 + j}`;
            if (key in displayOverrides) return displayOverrides[key];
            return cell === null || cell === undefined ? '' : String(cell);
          });
        }),
      };
      return range;
    },
    appendRow: (row) => rows.push(row),
    setConditionalFormatRules: (r) => { formatRules = r; },
    getConditionalFormatRules: () => formatRules,
  };

  // A second, simpler sheet stands in for the read-only Weekly tab.
  let weeklyGrid = [];
  const weeklySheet = {
    getName: () => 'Weekly',
    clear: () => { weeklyGrid = []; },
    setFrozenRows: () => {},
    getLastRow: () => weeklyGrid.length,
    getMaxRows: () => 1000,
    getRange: (r, c, nr, nc) => {
      const range = {
        setValues: (v) => {
          v.forEach((line, idx) => {
            weeklyGrid[r - 1 + idx] = (weeklyGrid[r - 1 + idx] || []).slice();
            line.forEach((cell, j) => { weeklyGrid[r - 1 + idx][c - 1 + j] = cell; });
          });
          return range;
        },
        setFontWeight: () => range,
        setNumberFormat: () => range,
        getValues: () => weeklyGrid.slice(r - 1, r - 1 + nr).map((x) => (x || []).slice(c - 1, c - 1 + nc)),
      };
      return range;
    },
  };

  const sheets = { Log: sheet, Weekly: weeklySheet };
  let spreadsheetTz = 'Etc/GMT';        // as clasp creates it: not the script's zone
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => sheets[n] || sheet,
    getSheets: () => [sheet, weeklySheet],
    getSpreadsheetTimeZone: () => spreadsheetTz,
    setSpreadsheetTimeZone: (t) => { spreadsheetTz = t; },
  };

  const props = {};
  const sandbox = {
    rows,
    checkboxCells,
    getFormatRules: () => formatRules,
    getWeeklyGrid: () => weeklyGrid,
    getSpreadsheetTz: () => spreadsheetTz,
    setDisplay: (rowIdx, colIdx, text) => { displayOverrides[`${rowIdx}:${colIdx}`] = text; },
    clearDisplays: () => { Object.keys(displayOverrides).forEach((k) => delete displayOverrides[k]); },
    clearWeeklyGrid: () => { weeklyGrid = []; },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; },
      }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      newConditionalFormatRule: () => {
        const spec = {};
        const b = {
          whenFormulaSatisfied: (f) => { spec.formula = f; return b; },
          setBackground: (c) => { spec.background = c; return b; },
          setRanges: (r) => { spec.ranges = r; return b; },
          build: () => spec,
        };
        return b;
      },
    },
    Session: { getScriptTimeZone: () => 'America/New_York' },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (t) => ({ setMimeType: () => ({ _text: t, getContent: () => t }) }),
    },
    Utilities: {
      // Stands in for Apps Script's SimpleDateFormat, for the patterns Code.gs uses.
      formatDate: (d, tz, fmt) => {
        const p = (n) => String(n).padStart(2, '0');
        const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        if (fmt === 'yyyy-MM-dd') return date;
        if (fmt === 'HH:mm:ss') return time;
        if (fmt === "yyyy-MM-dd'T'HH:mm:ss") return `${date}T${time}`;
        if (fmt === 'Z') {                       // RFC-822 offset, e.g. -0700
          const off = -d.getTimezoneOffset();
          const sign = off < 0 ? '-' : '+';
          const abs = Math.abs(off);
          return `${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
        }
        throw new Error('unmocked format: ' + fmt);
      },
    },
    console,
    Date,
    Math,
    JSON,
    isNaN,
    String,
    Object,
  };
  return sandbox;
}

const vm = require('vm');
const code = fs.readFileSync(SRC, 'utf8');
const env = makeEnv();
vm.createContext(env);
vm.runInContext(code, env);

// ---- helpers -------------------------------------------------------------
let now = new Date('2026-08-10T09:00:00-04:00');   // Monday
const RealDate = Date;
env.Date = class extends RealDate {
  constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(now); }
  static now() { return now.getTime(); }
};

const at = (iso) => { now = iso instanceof RealDate ? iso : new RealDate(iso); };
// Local-time constructor, so boundary tests hold in whatever TZ the suite runs in.
const local = (y, m, d, hh, mm) => new RealDate(y, m - 1, d, hh, mm, 0, 0);
const j = (o) => JSON.parse(JSON.stringify(o));

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got:      ${a}\n        expected: ${e}`}`);
}
const h = (x) => Math.round(x * 1000) / 1000;

// ---- scenario ------------------------------------------------------------
console.log('\n== Monday: clinic 9:00 -> 11:30, auto-switch to notes ==');
at('2026-08-10T09:00:00-04:00'); env.logEvent('clinic', 'start', 'button', '');
check('active is clinic', env.getActiveTask().task, 'clinic');

at('2026-08-10T11:30:00-04:00'); env.logEvent('notes', 'start', 'nfc', '');
check('auto-switch stopped clinic', env.rows[1][5], 'auto-switch');
check('active is notes', env.getActiveTask().task, 'notes');

at('2026-08-10T12:00:00-04:00');
let s = env.getSummary();
check('clinic = 2.5h', h(s.totals.clinic), 2.5);
check('notes partial = 0.5h', h(s.totals.notes), 0.5);
check('active reported', s.active.task, 'notes');
check('total = 3h', h(s.totalHours), 3);

console.log('\n== stop via location link (no task param) ==');
at('2026-08-10T12:15:00-04:00'); env.logEvent('', 'stop', 'location', '');
check('nothing active', env.getActiveTask(), null);
s = env.getSummary();
check('notes = 0.75h', h(s.totals.notes), 0.75);

console.log('\n== stop with nothing running is a no-op ==');
const before = env.rows.length;
at('2026-08-10T12:20:00-04:00'); env.logEvent('', 'stop', 'location', '');
check('no junk row appended', env.rows.length, before);

console.log('\n== starting an already-active task does not double-log ==');
at('2026-08-10T13:00:00-04:00'); env.logEvent('lunch', 'start', 'button', '');
const n2 = env.rows.length;
at('2026-08-10T13:05:00-04:00'); env.logEvent('lunch', 'start', 'nfc', '');
check('duplicate start ignored', env.rows.length, n2);
at('2026-08-10T13:30:00-04:00'); env.logEvent('lunch', 'stop', 'button', '');
check('lunch = 0.5h', h(env.getSummary().totals.lunch), 0.5);

console.log('\n== auto-stop safety after 6h ==');
at('2026-08-10T14:00:00-04:00'); env.logEvent('forms', 'start', 'nfc', '');
at('2026-08-10T21:00:00-04:00');            // 7h later
env.checkAutoStop();
check('auto-stopped', env.getActiveTask(), null);
s = env.getSummary();
check('flagged one entry', s.flagged.length, 1);
check('flagged task', s.flagged[0].task, 'forms');
check('forms = 7h', h(s.totals.forms), 7);

console.log('\n== week bounds: Mon 00:00 -> Sun 23:59 ==');
// Bounds are local-time, so compare local components (not the UTC ISO string).
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const wb = env.getWeekBounds(local(2026, 8, 13, 15, 0)); // Thursday
check('week starts Monday Aug 10', localDay(wb.start), '2026-08-10');
check('week starts at midnight', [wb.start.getHours(), wb.start.getMinutes()], [0, 0]);
check('week ends Sunday Aug 16', localDay(wb.end), '2026-08-16');
check('week ends at 23:59:59', [wb.end.getHours(), wb.end.getMinutes(), wb.end.getSeconds()], [23, 59, 59]);
const wbSun = env.getWeekBounds(local(2026, 8, 16, 15, 0)); // Sunday
check('Sunday still maps to Aug 10 week', localDay(wbSun.start), '2026-08-10');

console.log('\n== next week resets totals, prior week excluded ==');
at('2026-08-17T09:00:00-04:00');            // following Monday
s = env.getSummary();
check('clinic reset', h(s.totals.clinic), 0);
check('total reset', h(s.totalHours), 0);
check('flagged cleared (prior week)', s.flagged.length, 0);

console.log('\n== overnight session clipped at the week boundary ==');
at(local(2026, 8, 23, 22, 0)); env.logEvent('meeting', 'start', 'button', '');  // Sunday 10pm
at(local(2026, 8, 24,  1, 0)); env.logEvent('meeting', 'stop', 'button', '');   // Monday 1am
at(local(2026, 8, 24,  2, 0));
s = env.getSummary();
check('new week gets only the 1h after midnight', h(s.totals.meeting), 1);
at(local(2026, 8, 23, 23, 0));
check('prior week gets the 2h before midnight', h(env.getSummary().totals.meeting), 2);

console.log('\n== timestamps are written as readable local time ==');
at(local(2026, 8, 25, 9, 0)); env.logEvent('clinic', 'start', 'button', '');
const written = env.rows[env.rows.length - 1];
check('timestamp matches the Date column', written[0].slice(0, 10), written[1]);
check('timestamp matches the Time column', written[0].slice(11, 19), written[2]);
check('timestamp carries an explicit offset', /[+-]\d{2}:\d{2}$/.test(written[0]), true);
check('timestamp round-trips', env.getActiveTask().startTime.getTime(),
      local(2026, 8, 25, 9, 0).getTime());
at(local(2026, 8, 25, 10, 0)); env.logEvent('clinic', 'stop', 'button', '');

console.log('\n== hand-edited timestamp formats are accepted ==');
const formats = [
  ['local, no offset',      '2026-08-31 09:00:00', local(2026, 8, 31, 9, 0)],
  ['local, seconds omitted','2026-08-31 09:00',    local(2026, 8, 31, 9, 0)],
  ['ISO T separator',       '2026-08-31T09:00:00', local(2026, 8, 31, 9, 0)],
  ['date only -> midnight', '2026-08-31',          local(2026, 8, 31, 0, 0)],
  ['explicit offset',       '2026-08-31T09:00:00-07:00', new RealDate('2026-08-31T09:00:00-07:00')],
  ['UTC Z form',            '2026-08-31T16:00:00Z',      new RealDate('2026-08-31T16:00:00Z')],
];
formats.forEach(([label, text, expected]) => {
  check(label, env.parseTs_(text).getTime(), expected.getTime());
});
check('blank cell is ignored', env.parseTs_(''), null);
check('garbage is ignored', env.parseTs_('sometime tuesday'), null);

console.log('\n== forgotten timers are marked for review in the sheet ==');
env.rows.length = 0;
env.checkboxCells.length = 0;
at(local(2026, 10, 5, 9, 0)); env.logEvent('clinic', 'start', 'nfc', '');
at(local(2026, 10, 5, 16, 0));                       // 7h later, forgot to stop
env.checkAutoStop();
const flagRow = env.rows[env.rows.length - 1];
check('a stop row was written', flagRow[4], 'stop');
check('source marks it auto-safety', flagRow[5], 'auto-safety');
check('note explains why', /review/i.test(flagRow[6]), true);
check('row got a Verified checkbox', env.checkboxCells.length, 1);
check('checkbox is in column H', env.checkboxCells[0][1], 8);
check('ordinary rows get no checkbox',
      env.rows.filter((r) => r[5] !== 'auto-safety').length > 0 &&
      env.checkboxCells.length === 1, true);

const rules = env.getFormatRules();
check('a shading rule exists', rules.length, 1);
check('rule targets unverified auto-safety rows', rules[0].formula,
      '=AND($F2="auto-safety", $H2<>TRUE)');
check('rule shades amber', rules[0].background, '#F7E0C3');

at(local(2026, 10, 5, 17, 0));
let flagSummary = env.getSummary();
check('app flags it for review', flagSummary.flagged.length, 1);
check('flagged names the task', flagSummary.flagged[0].task, 'clinic');

console.log('\n== ticking Verified clears the flag ==');
env.rows[env.rows.length - 1][7] = true;
flagSummary = env.getSummary();
check('no longer flagged', flagSummary.flagged.length, 0);
check('but the hours are untouched', h(flagSummary.totals.clinic), 7);
env.rows[env.rows.length - 1][7] = 'TRUE';           // text form, as CSV import gives
check('text TRUE also counts as verified', env.getSummary().flagged.length, 0);
env.rows[env.rows.length - 1][7] = false;
check('unticking flags it again', env.getSummary().flagged.length, 1);

console.log('\n== the readable Date/Time columns are what count ==');
env.rows.length = 0;
// Timestamp says 09:00 but the Time column says 10:00 — the human edit wins.
env.rows.push(['2026-09-28T09:00:00-07:00', '2026-09-28', '10:00:00', 'clinic', 'start', 'manual', '']);
env.rows.push(['2026-09-28T09:00:00-07:00', '2026-09-28', '12:00:00', 'clinic', 'stop', 'manual', '']);
at(local(2026, 9, 28, 13, 0));
check('edited Time drives the total', h(env.getSummary().totals.clinic), 2);

console.log('\n== Date/Time cells that Sheets converted to real values ==');
env.rows.length = 0;
env.rows.push(['', local(2026, 9, 28, 0, 0), new RealDate(1899, 11, 30, 9, 0, 0), 'notes', 'start', 'manual', '']);
env.rows.push(['', local(2026, 9, 28, 0, 0), new RealDate(1899, 11, 30, 11, 30, 0), 'notes', 'stop', 'manual', '']);
at(local(2026, 9, 28, 13, 0));
check('date/time objects total 2.5h', h(env.getSummary().totals.notes), 2.5);

console.log('\n== other things a person might type into Time ==');
const timeForms = [
  ['24h with seconds', '14:30:00', 14, 30, 0],
  ['24h no seconds',   '14:30',    14, 30, 0],
  ['12-hour pm',       '2:30 PM',  14, 30, 0],
  ['12-hour am',       '9:05 AM',   9,  5, 0],
  ['midnight 12 AM',   '12:00 AM',  0,  0, 0],
  ['noon 12 PM',       '12:00 PM', 12,  0, 0],
];
timeForms.forEach(([label, text, h_, m_, s_]) => {
  const got = env.parseTimeCell_(text);
  check(label, [got.h, got.min, got.s], [h_, m_, s_]);
});
check('US-style date accepted', env.parseDateCell_('9/28/2026'), { y: 2026, m: 8, d: 28 });
// Sheets renders a date cell using the column's format; a two-digit year is
// common and used to fall through to the raw cell value, shifting the row.
check('two-digit year accepted', env.parseDateCell_('8/10/26'), { y: 2026, m: 7, d: 10 });
check('two-digit year at century edge', env.parseDateCell_('1/1/69'), { y: 1969, m: 0, d: 1 });
check('two-digit year just inside', env.parseDateCell_('1/1/68'), { y: 2068, m: 0, d: 1 });
check('written month accepted', env.parseDateCell_('Aug 10, 2026'), { y: 2026, m: 7, d: 10 });
check('blank Time means midnight', env.parseTimeCell_(''), { h: 0, min: 0, s: 0 });
check('unparseable Time rejected', env.parseTimeCell_('lunchtime'), null);

console.log('\n== a row with only Timestamp still works ==');
env.rows.length = 0;
env.rows.push(['2026-09-28T09:00:00-07:00', '', '', 'forms', 'start', 'manual', '']);
env.rows.push(['2026-09-28T10:00:00-07:00', '', '', 'forms', 'stop', 'manual', '']);
at(local(2026, 9, 28, 13, 0));
check('falls back to Timestamp', h(env.getSummary().totals.forms), 1);

console.log('\n== rows entered out of order are still paired correctly ==');
env.rows.length = 0;
// Deliberately append the stop above the start, as a hand-edit would.
env.rows.push(['2026-09-07 11:00:00', '2026-09-07', '11:00:00', 'clinic', 'stop', 'manual', '']);
env.rows.push(['2026-09-07 09:00:00', '2026-09-07', '09:00:00', 'clinic', 'start', 'manual', '']);
at(local(2026, 9, 7, 12, 0));
check('out-of-order pair totals 2h', h(env.getSummary().totals.clinic), 2);
check('nothing looks active', env.getActiveTask(), null);

console.log('\n== a correction inserted mid-log lands in the right place ==');
env.rows.push(['2026-09-07 14:00:00', '2026-09-07', '14:00:00', 'lunch', 'start', 'manual', '']);
env.rows.push(['2026-09-07 13:00:00', '2026-09-07', '13:00:00', 'notes', 'stop', 'manual', '']);
env.rows.push(['2026-09-07 12:30:00', '2026-09-07', '12:30:00', 'notes', 'start', 'manual', '']);
env.rows.push(['2026-09-07 14:30:00', '2026-09-07', '14:30:00', 'lunch', 'stop', 'manual', '']);
at(local(2026, 9, 7, 15, 0));
let sc = env.getSummary();
check('clinic still 2h', h(sc.totals.clinic), 2);
check('notes 0.5h', h(sc.totals.notes), 0.5);
check('lunch 0.5h', h(sc.totals.lunch), 0.5);

console.log('\n== simultaneous auto-switch rows keep their order ==');
env.rows.length = 0;
at(local(2026, 9, 14, 9, 0)); env.logEvent('clinic', 'start', 'button', '');
at(local(2026, 9, 14, 11, 0)); env.logEvent('notes', 'start', 'nfc', '');   // same instant
at(local(2026, 9, 14, 12, 0)); env.logEvent('notes', 'stop', 'button', '');
sc = env.getSummary();
check('clinic keeps its 2h', h(sc.totals.clinic), 2);
check('notes keeps its 1h', h(sc.totals.notes), 1);

console.log('\n== Weekly tab: one row per week, newest first ==');
env.rows.length = 0;
// Two sessions in the week of Mon Oct 12, one in the week of Mon Oct 19.
env.rows.push(['', '2026-10-12', '09:00:00', 'clinic', 'start', 'manual', '', '']);
env.rows.push(['', '2026-10-12', '12:00:00', 'clinic', 'stop', 'manual', '', '']);
env.rows.push(['', '2026-10-14', '09:00:00', 'notes', 'start', 'manual', '', '']);
env.rows.push(['', '2026-10-14', '10:30:00', 'notes', 'stop', 'manual', '', '']);
env.rows.push(['', '2026-10-20', '13:00:00', 'lunch', 'start', 'manual', '', '']);
env.rows.push(['', '2026-10-20', '14:00:00', 'lunch', 'stop', 'manual', '', '']);
at(local(2026, 10, 21, 9, 0));
env.rebuildWeekly_();
let grid = env.getWeeklyGrid();

check('header row', grid[0], ['Week of (Mon)', 'Clinic', 'Lunch', 'Notes', 'Inbox',
                             'Forms', 'Meeting', 'Total']);
check('two week rows', grid.length - 1, 2);
check('newest week first', grid[1][0], '2026-10-19');
check('older week second', grid[2][0], '2026-10-12');
check('lunch 1h in the newer week', grid[1][2], 1);
check('newer week total', grid[1][7], 1);
check('clinic 3h in the older week', grid[2][1], 3);
check('notes 1.5h in the older week', grid[2][3], 1.5);
check('older week total', grid[2][7], 4.5);
check('untouched task reads 0', grid[2][4], 0);

console.log('\n== a session crossing Sunday midnight splits across weeks ==');
env.rows.length = 0;
env.rows.push(['', '2026-10-18', '22:00:00', 'meeting', 'start', 'manual', '', '']);
env.rows.push(['', '2026-10-19', '01:00:00', 'meeting', 'stop', 'manual', '', '']);
at(local(2026, 10, 20, 9, 0));
env.rebuildWeekly_();
grid = env.getWeeklyGrid();
check('split across two weeks', grid.length - 1, 2);
check('1h lands in the new week', grid[1][6], 1);
check('2h stays in the old week', grid[2][6], 2);

console.log('\n== Weekly agrees with what the app reports ==');
env.rows.length = 0;
at(local(2026, 10, 26, 9, 0)); env.logEvent('clinic', 'start', 'button', '');
at(local(2026, 10, 26, 11, 30)); env.logEvent('notes', 'start', 'nfc', '');
at(local(2026, 10, 26, 12, 0)); env.logEvent('notes', 'stop', 'button', '');
at(local(2026, 10, 26, 13, 0));
env.rebuildWeekly_();
grid = env.getWeeklyGrid();
const appTotals = env.getSummary();
check('same clinic hours', grid[1][1], h(appTotals.totals.clinic));
check('same notes hours', grid[1][3], h(appTotals.totals.notes));
check('same total', grid[1][7], h(appTotals.totalHours));

console.log('\n== a running task counts toward the current week ==');
env.rows.length = 0;
at(local(2026, 11, 2, 9, 0)); env.logEvent('forms', 'start', 'button', '');
at(local(2026, 11, 2, 11, 0));
env.rebuildWeekly_();
check('running time included', env.getWeeklyGrid()[1][5], 2);

console.log('\n== rebuilding is idempotent and drops removed weeks ==');
env.rows.length = 0;
at(local(2026, 11, 9, 9, 0));
env.rebuildWeekly_();
check('empty log leaves only the header', env.getWeeklyGrid().length, 1);

console.log('\n== editing the Log refreshes Weekly ==');
env.rows.length = 0;
env.rows.push(['', '2026-11-16', '09:00:00', 'inbox', 'start', 'manual', '', '']);
env.rows.push(['', '2026-11-16', '10:00:00', 'inbox', 'stop', 'manual', '', '']);
at(local(2026, 11, 16, 11, 0));
env.onEdit({ range: { getSheet: () => ({ getName: () => 'Log' }) } });
check('onEdit rebuilt the tab', env.getWeeklyGrid()[1][4], 1);
env.rows.push(['', '2026-11-16', '11:00:00', 'inbox', 'start', 'manual', '', '']);
env.onEdit({ range: { getSheet: () => ({ getName: () => 'Weekly' }) } });
check('edits to other tabs are ignored', env.getWeeklyGrid()[1][4], 1);
check('a malformed event does not throw', env.onEdit({}), undefined);

console.log('\n== deleted rows are picked up without any trigger ==');
env.rows.length = 0;
env.rows.push(['', '2026-11-23', '09:00:00', 'clinic', 'start', 'manual', '', '']);
env.rows.push(['', '2026-11-23', '12:00:00', 'clinic', 'stop', 'manual', '', '']);
at(local(2026, 11, 23, 13, 0));
env.getSummary();                                   // builds Weekly
check('Weekly shows the 3h', env.getWeeklyGrid()[1][1], 3);

// Delete the rows the way the Sheets UI does — no onEdit fires for this.
env.rows.length = 0;
env.getSummary();
check('Weekly self-heals to empty', env.getWeeklyGrid().length, 1);

console.log('\n== an unchanged log does not rewrite the tab ==');
env.rows.push(['', '2026-11-23', '09:00:00', 'lunch', 'start', 'manual', '', '']);
env.rows.push(['', '2026-11-23', '10:00:00', 'lunch', 'stop', 'manual', '', '']);
env.getSummary();
check('rebuilt once for the new rows', env.getWeeklyGrid()[1][2], 1);
env.clearWeeklyGrid();                              // if it rebuilds, we will see it
env.getSummary();
env.getSummary();
check('repeat refreshes skip the write', env.getWeeklyGrid().length, 0);

console.log('\n== a computation change forces one rebuild ==');
// The log is unchanged, so only the algorithm version can trigger this. Without
// it the tab would keep serving figures produced by superseded code.
env.clearWeeklyGrid();
env.getSummary();
check('unchanged log still skips the write', env.getWeeklyGrid().length, 0);
check('fingerprint carries the algorithm version',
      env.buildIntervals_().fingerprint.split(':')[0], env.WEEKLY_ALGO_VERSION);

console.log('\n== editing a time in place is still noticed ==');
env.rows[1][2] = '11:00:00';                        // 1h becomes 2h
env.getSummary();
check('edit triggers a rebuild', env.getWeeklyGrid()[1][2], 2);

console.log('\n== hand-typed cells that Sheets stored in another timezone ==');
// Reproduces the real failure: the spreadsheet was created in GMT while the
// script runs in Pacific, so a typed "2026-08-11 / 08:30" came back as a Date
// meaning 2026-08-11T00:00Z — which reads as Aug 10, 17:00 in the script's
// zone, moving the entry to the previous day and shifting it eight hours.
env.rows.length = 0;
env.clearDisplays();
env.rows.push([
  '',
  new RealDate('2026-08-11T00:00:00.000Z'),        // Date column, GMT-anchored
  new RealDate('1899-12-30T08:30:00.000Z'),        // Time column, GMT-anchored
  'notes', 'start', 'manual', '', '']);
env.rows.push([
  '',
  new RealDate('2026-08-11T00:00:00.000Z'),
  new RealDate('1899-12-30T10:30:00.000Z'),
  'notes', 'stop', 'manual', '', '']);
// What the user actually sees in those cells:
env.setDisplay(0, 1, '2026-08-11'); env.setDisplay(0, 2, '08:30:00');
env.setDisplay(1, 1, '2026-08-11'); env.setDisplay(1, 2, '10:30:00');

at(local(2026, 8, 11, 12, 0));
const shifted = env.getSummary();
check('the 2h is counted, not lost', h(shifted.totals.notes), 2);

const parsedStart = env.rowWhen_(env.getRows_()[0]);
check('lands on the day shown in the cell', parsedStart.getDate(), 11);
check('at the time shown in the cell', [parsedStart.getHours(), parsedStart.getMinutes()], [8, 30]);

console.log('\n== the spreadsheet timezone is realigned to the script ==');
check('mismatch corrected on schema upgrade', env.getSpreadsheetTz(), 'America/New_York');

console.log('\n== an unrecognised display format falls back to the cell value ==');
env.clearDisplays();
env.setDisplay(0, 1, 'Tuesday, 11 August');        // nothing the parsers know
env.setDisplay(1, 1, 'Tuesday, 11 August');
check('still parses via the underlying value', env.rowWhen_(env.getRows_()[0]) !== null, true);

console.log('\n== doGet routing ==');
env.rows.length = 0;
at(local(2026, 9, 21, 9, 0));
let out = JSON.parse(env.doGet({ parameter: { summary: '1' } })._text);
check('summary status ok', out.status, 'ok');
out = JSON.parse(env.doGet({ parameter: { action: 'start', task: 'inbox', source: 'nfc' } })._text);
check('start via doGet', out.active.task, 'inbox');
out = JSON.parse(env.doGet({ parameter: { action: 'start', task: 'bogus' } })._text);
check('bad task rejected', out.status, 'error');
out = JSON.parse(env.doPost({ postData: { contents: '{"action":"stop","source":"api"}' } })._text);
check('stop via doPost', out.active, null);

console.log(`\n${failures === 0 ? 'All checks passed.' : failures + ' CHECK(S) FAILED.'}`);
process.exit(failures === 0 ? 0 : 1);
