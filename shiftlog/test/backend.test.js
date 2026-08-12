// Harness: run Code.gs against a fake Sheets/Apps Script environment.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'apps-script', 'Code.gs');

function makeEnv() {
  const rows = [];       // data rows only
  let header = null;

  const checkboxCells = [];        // [row, col] pairs given a checkbox
  let formatRules = [];

  const sheet = {
    getLastRow: () => (header ? rows.length + 1 : 0),
    getMaxRows: () => 1000,
    setFrozenRows: () => {},
    getRange: (r, c, nr, nc) => {
      const range = {
        setValues: (v) => { if (r === 1) header = v[0]; return range; },
        setFontWeight: () => range,
        setNumberFormat: () => range,
        insertCheckboxes: () => { checkboxCells.push([r, c]); return range; },
        getValues: () => rows.slice(r - 2, r - 2 + nr).map((x) => x.slice(c - 1, c - 1 + nc)),
      };
      return range;
    },
    appendRow: (row) => rows.push(row),
    setConditionalFormatRules: (r) => { formatRules = r; },
    getConditionalFormatRules: () => formatRules,
  };

  const ss = { getSheetByName: (n) => (n === 'Log' ? sheet : null), insertSheet: () => sheet };

  const props = {};
  const sandbox = {
    rows,
    checkboxCells,
    getFormatRules: () => formatRules,
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
