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

  // ---- fresh install: no URL saved -> settings sheet opens itself ----
  const fresh = await browser.newContext({ ...devices['iPhone 13'] });
  const fp = await fresh.newPage();
  await fp.goto(BASE + '/index.html');
  await fp.waitForTimeout(1200);
  ok('first run does NOT open settings',
     await fp.locator('#sheet.open').count() === 0);
  ok('unconfigured banner points at the gear',
     (await fp.locator('#bannerWhat').textContent()).trim() === 'Not connected',
     (await fp.locator('#bannerWhat').textContent()).trim());
  ok('and says how to fix it',
     (await fp.locator('#bannerSince').textContent()).includes('gear'));
  await fp.locator('#gearBtn').click();
  await fp.waitForTimeout(700);
  ok('gear still opens settings on demand',
     await fp.locator('#sheet.open').count() === 1);
  await fp.screenshot({ path: OUT + '/shot-firstrun.png', fullPage: true });
  await fresh.close();

  // ---- seeded weekly data ----
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
  ok('week label says Mon–Sun',
     (await page.locator('#weekRange').textContent()).includes('Mon–Sun'),
     await page.locator('#weekRange').textContent());
  ok('idle banner', (await page.locator('#bannerWhat').textContent()).trim() === 'Nothing running');
  ok('total hours rendered', (await page.locator('#totalHours').textContent()).trim() === '24h 06m',
     await page.locator('#totalHours').textContent());
  ok('flagged card visible when entries exist',
     await page.locator('#flaggedCard.show').count() === 1);
  ok('flagged mentions review',
     (await page.locator('#flaggedCard .sub').textContent()).includes('overestimate'));

  // bar widths are proportional to the largest task
  const w = await page.locator('[data-fill="clinic"]').evaluate((e) => e.style.width);
  const w2 = await page.locator('[data-fill="lunch"]').evaluate((e) => e.style.width);
  ok('largest bar is full width', w === '100%', w);
  ok('smaller bar is proportional', parseFloat(w2) > 0 && parseFloat(w2) < 100, w2);

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

  const t1 = await page.locator('#bannerElapsed').textContent();
  await page.waitForTimeout(2500);
  const t2 = await page.locator('#bannerElapsed').textContent();
  ok('live timer advances', t1 !== t2, `${t1} -> ${t2}`);
  ok('timer format M:SS', /^\d+:\d{2}$/.test(t2.trim()), t2);
  ok('tile shows same timer',
     (await page.locator('.tile.active .state').textContent()).trim() === t2.trim());

  await page.screenshot({ path: OUT + '/shot-running.png', fullPage: true });

  // ---- switching tasks ----
  await page.locator('.tile[data-task="notes"]').click();
  await page.waitForTimeout(1800);
  ok('switching moves the active ring',
     await page.locator('.tile[data-task="notes"].active').count() === 1 &&
     await page.locator('.tile[data-task="clinic"].active').count() === 0);

  // ---- tap active tile to stop ----
  await page.locator('.tile[data-task="notes"]').click();
  await page.waitForTimeout(1800);
  ok('stop clears the banner',
     (await page.locator('#bannerWhat').textContent()).trim() === 'Nothing running');
  ok('no active tiles after stop', await page.locator('.tile.active').count() === 0);

  // ---- settings + NFC links ----
  await page.locator('#gearBtn').click();
  await page.waitForTimeout(800);
  const urls = await page.locator('.link .lurl').allTextContents();
  ok('seven links generated (6 tasks + location stop)', urls.length === 7, urls.length);
  ok('clinic start link correct',
     urls[0] === BASE + '/exec?action=start&task=clinic&source=nfc', urls[0]);
  ok('location stop link correct',
     urls[6] === BASE + '/exec?action=stop&source=location', urls[6]);
  ok('copy buttons present', await page.locator('.copy').count() === 7);
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
