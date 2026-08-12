// Harness: run Code.gs against a fake Sheets/Apps Script environment.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'apps-script', 'Code.gs');

function makeEnv() {
  const rows = [];       // data rows only
  let header = null;

  const sheet = {
    getLastRow: () => (header ? rows.length + 1 : 0),
    getMaxRows: () => 1000,
    setFrozenRows: () => {},
    getRange: (r, c, nr, nc) => ({
      setValues: (v) => { if (r === 1) header = v[0]; },
      setFontWeight: () => {},
      setNumberFormat: () => {},
      getValues: () => rows.slice(r - 2, r - 2 + nr).map((x) => x.slice(c - 1, c - 1 + nc)),
    }),
    appendRow: (row) => rows.push(row),
  };

  const ss = { getSheetByName: (n) => (n === 'Log' ? sheet : null), insertSheet: () => sheet };

  const sandbox = {
    rows,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
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
