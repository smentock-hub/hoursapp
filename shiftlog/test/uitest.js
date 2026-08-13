const { chromium, devices } = require('playwright');

const BASE = 'http://127.0.0.1:8099';
const OUT = __dirname;
let pass = 0, fail = 0;

function ok(label, cond, extra) {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? '  [' + extra + ']' : ''}`);
}

(async () => {
  const browser = await chromium.launch({
    // Set CHROMIUM_PATH to reuse a preinstalled browser instead of Playwright's
    // own download; --no-proxy-server keeps a corporate/agent proxy out of the
    // way, since every request here is to localhost.
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ['--no-sandbox', '--no-proxy-server'],
  });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await ctx.addInitScript((url) => localStorage.setItem('shiftlog.url', url), BASE + '/exec');

  // ---- fresh install: no URL saved ----
  const fresh = await browser.newContext({ ...devices['iPhone 13'] });
  const fp = await fresh.newPage();
  await fp.goto(BASE + '/index.html');
  await fp.waitForTimeout(1200);
  ok('first run does NOT open settings',
     await fp.locator('#sheet.open').count() === 0);
  ok('unconfigured banner points at the gear',
     (await fp.locator('#bannerWhat').textContent()).trim() === 'Not connected',
     (await fp.locator('#bannerWhat').textContent()).trim());
  ok('and the notice says how to fix it',
     (await fp.locator('#weekProblemText').textContent()).includes('Web App URL'));
  ok('a notice explains the disconnection',
     await fp.locator('#weekProblem.show').count() === 1);
  ok('with a button into settings',
     await fp.locator('#weekProblemBtn').isVisible());
  ok('End day is disabled while disconnected',
     await fp.locator('#endDayBtn').isDisabled());
  await fp.locator('#gearBtn').click();
  await fp.waitForTimeout(700);
  ok('gear still opens settings on demand',
     await fp.locator('#sheet.open').count() === 1);
  await fp.screenshot({ path: OUT + '/shot-firstrun.png', fullPage: true });
  await fresh.close();

  // ---- connected ----
  await page.goto(BASE + '/__reset');
  await page.goto(BASE + '/__seed');
  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  ok('six task tiles', await page.locator('.tile').count() === 6);
  ok('tile labels',
     (await page.locator('.tile .name').allTextContents()).join(',') ===
     'Clinic,Lunch,Notes,Inbox,Forms,Meeting');
  ok('header shows today', /\w+day/.test(await page.locator('#today').textContent()),
     await page.locator('#today').textContent());
  ok('idle current-task bar reads None',
     (await page.locator('#bannerWhat').textContent()).trim() === 'None');
  ok('connected: no problem notice', await page.locator('#weekProblem.show').count() === 0);
  ok('End day disabled when nothing is running',
     await page.locator('#endDayBtn').isDisabled());

  // No hours anywhere in the app: that lives in the sheet now.
  const body = await page.locator('body').innerText();
  ok('no hours shown anywhere', !/\d+h \d{2}m/.test(body), body.replace(/\n/g, ' | ').slice(0, 120));
  ok('no weekly table remains', await page.locator('[data-fill]').count() === 0);
  ok('no flagged card remains', await page.locator('#flaggedCard').count() === 0);

  // The tap target should be comfortably large on a phone. 132px is well above
  // the 108px the tiles started at; the rest of the budget goes to the marker
  // buttons, which have to be reachable without scrolling.
  const box = await page.locator('.tile[data-task="clinic"]').boundingBox();
  ok('tiles are a big target', box.height >= 130, `${Math.round(box.width)}x${Math.round(box.height)}`);

  await page.screenshot({ path: OUT + '/shot-summary.png', fullPage: true });

  // ---- tap to start ----
  await page.locator('.tile[data-task="clinic"]').click();
  await page.waitForTimeout(250);
  ok('optimistic: tile active immediately',
     await page.locator('.tile[data-task="clinic"].active').count() === 1);
  await page.waitForTimeout(1800);
  ok('banner shows running task',
     (await page.locator('#bannerWhat').textContent()).includes('Clinic'),
     (await page.locator('#bannerWhat').textContent()).trim());
  ok('banner has pulsing state class', await page.locator('#banner.running').count() === 1);
  ok('breathing ring on exactly one tile', await page.locator('.tile.active').count() === 1);

  ok('no timer is displayed', await page.locator('#bannerElapsed').count() === 0);
  ok('the selected tile is marked Current',
     (await page.locator('.tile.active .state').textContent()).trim() === 'Current');
  ok('End day becomes available', !(await page.locator('#endDayBtn').isDisabled()));

  // It must read as the one control that ends the day, not a seventh tile.
  const endBox = await page.locator('#endDayBtn').boundingBox();
  ok('End day is a tall target', endBox.height >= 60, `${Math.round(endBox.height)}px`);
  const endBg = await page.locator('#endDayBtn').evaluate((e) => getComputedStyle(e).backgroundColor);
  ok('End day is filled with the dark ink', endBg === 'rgb(69, 63, 73)', endBg);
  const tileBgs = await page.locator('.tile').evaluateAll(
    (els) => els.map((e) => getComputedStyle(e).backgroundColor));
  ok('and shares no colour with any tile', !tileBgs.includes(endBg));
  ok('End day sits above the fold',
     endBox.y + endBox.height <= page.viewportSize().height,
     `${Math.round(endBox.y + endBox.height)} of ${page.viewportSize().height}`);
  // Launched from the home screen there is no browser chrome, so the usable
  // height is roughly 750. Every control must fit inside that, markers included.
  const contentHeight = await page.evaluate(() => document.body.scrollHeight);
  ok('all controls fit a standalone phone screen', contentHeight <= 720,
     `${Math.round(contentHeight)}px of a ~750px budget`);

  await page.screenshot({ path: OUT + '/shot-running.png', fullPage: true });

  // ---- switching tasks ----
  await page.locator('.tile[data-task="notes"]').click();
  await page.waitForTimeout(1800);
  ok('switching moves the active ring',
     await page.locator('.tile[data-task="notes"].active').count() === 1 &&
     await page.locator('.tile[data-task="clinic"].active').count() === 0);

  // ---- re-tapping the current tile must NOT stop it ----
  await page.locator('.tile[data-task="notes"]').click();
  await page.waitForTimeout(1800);
  ok('re-tapping the current task keeps it running',
     (await page.locator('#bannerWhat').textContent()).trim() === 'Notes');
  ok('and it is still the marked tile',
     await page.locator('.tile[data-task="notes"].active').count() === 1);

  // ---- End day is the only way to stop ----
  await page.locator('#endDayBtn').click();
  await page.waitForTimeout(1800);
  ok('End day clears the current task',
     (await page.locator('#bannerWhat').textContent()).trim() === 'None');
  ok('no tile is marked after End day', await page.locator('.tile.active').count() === 0);
  ok('End day disables itself again', await page.locator('#endDayBtn').isDisabled());

  // ---- timestamp markers ----
  const beforeMarks = await (await fetch(BASE + '/__marks')).json();
  const stateBefore = (await page.locator('#bannerWhat').textContent()).trim();

  await page.locator('#arriveBtn').click();
  await page.waitForTimeout(1500);
  await page.locator('#leaveBtn').click();
  await page.waitForTimeout(1500);

  const marks = await (await fetch(BASE + '/__marks')).json();
  ok('both markers reached the server', marks.length === beforeMarks.length + 2, marks.length);
  ok('arrival carries its source and note',
     marks[0].search.includes('source=arrive-hospital') &&
     marks[0].search.includes('Arrived%20at%20hospital'), marks[0].search);
  ok('departure carries its source and note',
     marks[1].search.includes('source=leave-hospital') &&
     marks[1].search.includes('Left%20the%20hospital'), marks[1].search);

  // The whole point: a marker changes nothing about what is being timed.
  ok('markers do not change the current task',
     (await page.locator('#bannerWhat').textContent()).trim() === stateBefore, stateBefore);
  ok('markers start no task', await page.locator('.tile.active').count() === 0);
  ok('markers leave End day untouched', await page.locator('#endDayBtn').isDisabled());
  ok('a confirmation is shown',
     /recorded at/.test(await page.locator('#toast').textContent()),
     await page.locator('#toast').textContent());

  // ---- settings + NFC links ----
  await page.locator('#gearBtn').click();
  await page.waitForTimeout(800);
  const urls = await page.locator('.link .lurl').allTextContents();
  ok('nine links generated (6 tasks + end day + 2 markers)', urls.length === 9, urls.length);
  ok('clinic start link correct',
     urls[0] === BASE + '/exec?action=start&task=clinic&source=nfc', urls[0]);
  ok('end-day link correct',
     urls[6] === BASE + '/exec?action=stop&source=leave-clinic', urls[6]);
  ok('arrive marker link correct',
     urls[7] === BASE + '/exec?action=mark&source=arrive-hospital&note=Arrived%20at%20hospital', urls[7]);
  ok('leave marker link correct',
     urls[8] === BASE + '/exec?action=mark&source=leave-hospital&note=Left%20the%20hospital', urls[8]);
  ok('copy buttons present', await page.locator('.copy').count() === 9);
  ok('settings shows the installed version',
     /^\d{4}-\d{2}-\d{2}$/.test((await page.locator('#buildStamp').textContent()).trim()),
     await page.locator('#buildStamp').textContent());
  await page.screenshot({ path: OUT + '/shot-settings.png', fullPage: true });

  // ---- offline queue ----
  await page.locator('#closeSheet').click();
  await page.waitForTimeout(400);
  await ctx.setOffline(true);
  await page.locator('.tile[data-task="forms"]').click();
  await page.waitForTimeout(1500);
  const queued = await page.evaluate(() => JSON.parse(localStorage.getItem('shiftlog.queue') || '[]'));
  ok('failed tap is queued offline', queued.length === 1, JSON.stringify(queued[0] && queued[0].params));
  ok('UI still shows it as running (optimistic)',
     await page.locator('.tile[data-task="forms"].active').count() === 1);

  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(2500);
  const drained = await page.evaluate(() => JSON.parse(localStorage.getItem('shiftlog.queue') || '[]'));
  ok('queue drains when back online', drained.length === 0, JSON.stringify(drained));

  const hits = await (await fetch(BASE + '/__hits')).json();
  ok('queued action reached the server',
     hits.some((h) => h.includes('task=forms') && h.includes('action=start')));

  // The offline test above intentionally severs the network, so the fetch
  // failure it logs is expected; anything else is a real bug.
  const real = errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e));
  ok('no unexpected JS errors', real.length === 0, real.join(' | ') || 'clean');
  ok('offline test did sever the network (sanity)',
     errors.some((e) => /ERR_INTERNET_DISCONNECTED/.test(e)));

  console.log(`\n${fail === 0 ? 'All ' + pass + ' UI checks passed.' : fail + ' FAILED, ' + pass + ' passed.'}`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})();
