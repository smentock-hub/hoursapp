// Serves web/ plus a stand-in for the Apps Script /exec endpoint, so the
// frontend can be driven in a real browser without external network.
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB = require('path').join(__dirname, '..', 'web');
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.png': 'image/png' };

let active = null;                       // {task, startTime}
const totals = { clinic: 0, lunch: 0, notes: 0, inbox: 0, forms: 0, meeting: 0 };
let flagged = [];
const hits = [];
const marks = [];

function weekBounds() {
  const d = new Date();
  const since = d.getDay() === 0 ? 6 : d.getDay() - 1;
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate() - since, 0, 0, 0, 0);
  const e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6, 23, 59, 59, 999);
  return { s, e };
}

function summary() {
  const { s, e } = weekBounds();
  const t = { ...totals };
  if (active) t[active.task] += (Date.now() - new Date(active.startTime)) / 3600000;
  Object.keys(t).forEach((k) => (t[k] = Math.round(t[k] * 1000) / 1000));
  return {
    status: 'ok',
    weekStart: s.toISOString(),
    weekEnd: e.toISOString(),
    totals: t,
    totalHours: Math.round(Object.values(t).reduce((a, b) => a + b, 0) * 1000) / 1000,
    active,
    flagged,
  };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');

  if (u.pathname === '/exec') {
    hits.push(u.search);
    const action = u.searchParams.get('action');
    const task = u.searchParams.get('task');
    if (action === 'start') {
      if (active && active.task !== task) {
        totals[active.task] += (Date.now() - new Date(active.startTime)) / 3600000;
      }
      if (!active || active.task !== task) {
        active = { task, startTime: new Date().toISOString() };
      }
    } else if (action === 'mark') {
      marks.push({ at: new Date().toISOString(), search: u.search });
    } else if (action === 'stop') {
      if (active) {
        totals[active.task] += (Date.now() - new Date(active.startTime)) / 3600000;
        active = null;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(summary()));
  }

  if (u.pathname === '/__marks') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(marks));
  }
  if (u.pathname === '/__hits') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(hits));
  }
  if (u.pathname === '/__reset') {
    active = null; flagged = []; hits.length = 0; marks.length = 0;
    Object.keys(totals).forEach((k) => (totals[k] = 0));
    res.writeHead(200); return res.end('reset');
  }
  if (u.pathname === '/__tiny') {
    totals.clinic = 0.001; totals.notes = 0.001;
    res.writeHead(200); return res.end('tiny');
  }
  // Preload fixture data so the summary card and flagged card have content.
  if (u.pathname === '/__seed') {
    totals.clinic = 12.5; totals.lunch = 2.25; totals.notes = 4.1;
    totals.inbox = 1.75; totals.forms = 0.5; totals.meeting = 3.0;
    flagged = [{ task: 'inbox', time: new Date(Date.now() - 86400000).toISOString(),
                 note: 'Auto-stopped after 6h — review, may be inaccurate.' }];
    res.writeHead(200); return res.end('seeded');
  }

  const file = path.join(WEB, u.pathname === '/' ? 'index.html' : u.pathname);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
});

server.listen(8099, '127.0.0.1', () => console.log('mock backend on 8099'));
