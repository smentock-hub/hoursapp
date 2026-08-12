# Shift Log

A phone-first time tracker for six task categories — Clinic, Lunch, Notes,
Inbox, Forms, Meeting — backed by a Google Sheet.

| Piece | Where |
| --- | --- |
| Web app (PWA) | https://shift-log.pages.dev |
| Backend (Apps Script web app) | `https://script.google.com/macros/s/AKfycbzeAjV9VK4Hw9OOpqyR3Ocgco8kD9NheWVtIKmbTgDOJz1AnRvZN6WTSYci7wChkwGcSQ/exec` |
| Data | Google Sheet "Shift Log": `Log` (events) and `Weekly` (rollup) |

## Setup on a phone

1. Open https://shift-log.pages.dev in Safari.
2. Share → **Add to Home Screen**. It launches full-screen with no browser chrome.
3. Open it, tap the gear, paste the `/exec` URL above, tap **Save**.

The URL is stored in `localStorage`, so it is per-device — repeat step 3 on any
other phone or tablet.

## How tracking works

- Tap a tile to start it. Tapping the running tile stops it.
- Only one task runs at a time: starting a new one **auto-stops** the previous
  one at the same instant, logged with source `auto-switch`.
- A task left running for **6 hours** is auto-stopped with source `auto-safety`,
  since the real stop was probably earlier and the logged time is likely an
  overestimate. Such a row is **shaded amber in the sheet**, carries a
  `Verified` checkbox, and is listed under "Needs review" in the app. Correct
  its `Time`, then tick `Verified`: the shading clears and it drops out of the
  app's review list. The hours themselves are never altered by ticking it.

  The shading is a conditional-format rule (`Source` is `auto-safety` and
  `Verified` is not `TRUE`), set up once, so it maintains itself without any
  rewriting of past rows.
- The weekly summary covers **Monday 00:00 – Sunday 23:59** in the project
  timezone (`America/Los_Angeles`). Sessions that cross midnight into a new week
  are split at the boundary.

## NFC tags and location triggers

Settings lists a copyable link per task plus one location-stop link. Write a
task link to an NFC sticker (NFC Tools, or Shortcuts → Automation → NFC) and
place it where the work happens; tapping the phone to it starts that task
without unlocking into the app.

The stop link is meant for a Shortcuts automation — e.g. "When I leave the
clinic, open URL" — so the running task closes even if you forget.

Links follow this shape:

```
{exec}?action=start&task=clinic&source=nfc
{exec}?action=stop&source=location
```

`source` is recorded in the sheet, so you can tell later which entries came from
a tag, a location trigger, a tap in the app, or an automatic stop.

## Offline

Taps made without a connection are queued in `localStorage`, replayed when the
network returns, on the browser's `online` event, and on a 20s retry timer. The
app also refreshes the summary every 60s while open.

## The Weekly tab

A second, read-only tab: one row per Mon–Sun week, newest at the top, with a
column per task and a total.

```
Week of (Mon)   Clinic  Lunch  Notes  Inbox  Forms  Meeting  Total
2026-10-19        6.25   2.00   3.50   1.00   0.50     2.00  15.25
2026-10-12       21.00   4.25   8.00   3.25   1.00     4.50  42.00
```

It is **recomputed from the Log**, never accumulated, so a correction to a past
row is reflected the next time it runs and the tab can never drift out of step
with the log it summarises. Both it and the app's weekly figures come from the
same pairing code, so the two cannot disagree.

Rebuilds happen when the app records an event and, via an `onEdit` trigger,
after you edit the Log by hand. A session running past Sunday midnight is split
across the two weeks rather than counted wholly in one.

Do not type into this tab — it is overwritten on every rebuild.

## Sheet columns

`Timestamp` · `Date` · `Time` · `Task` · `Action` · `Source` · `Note` · `Verified`

The `Log` tab and its header row are created automatically on first write.

## Correcting entries by hand

Edit the sheet directly — every total is recomputed from these rows on each
request, so there is no cached state to invalidate.

**Edit the `Date` and `Time` columns. Ignore `Timestamp`.** Those two readable
columns are what the totals are computed from; `Timestamp` is a machine-format
copy kept only as a fallback for rows where `Date`/`Time` are blank.

`Time` accepts whatever is natural to type:

| You type | Means |
| --- | --- |
| `2:30 PM` | 2:30 pm |
| `14:30` | the same, 24-hour |
| `14:30:00` | the same, seconds optional |
| `9:05 AM` | 9:05 am |

`Date` accepts `2026-08-11` or `8/11/2026`, and Sheets' own date and time cell
values work too. A blank `Time` means midnight.

Rows are sorted chronologically before pairing, so a correction does **not**
need to go in the right position — add it at the bottom and the totals still
come out right. Two rows sharing a time keep their sheet order, which is what
makes an auto-switch's stop-then-start pair unambiguous.

Two rules still apply: `start` and `stop` must alternate for a task to be
paired, and if the chronologically last row is a `start`, the app treats that
task as currently running.

## Development

```sh
cd test && npm install

# backend logic against a fake Sheets environment (97 checks).
# Run it in the project timezone — week boundaries are local-time.
TZ=America/Los_Angeles npm run test:backend

# frontend in a real browser against a mock backend (31 checks).
npm run serve &                  # serves ../web plus a stand-in /exec on :8099
npm run test:ui                  # set CHROMIUM_PATH to reuse an existing browser
```

Deploying:

```sh
cd apps-script && clasp push && clasp deploy --description "vN"
cd web && wrangler pages deploy . --project-name=shift-log --branch main
```

`clasp deploy` mints a **new** deployment id and therefore a new `/exec` URL. To
keep the URL already saved on the phone and written to NFC tags, update the
existing deployment in place instead:

```sh
clasp redeploy AKfycbzeAjV9VK4Hw9OOpqyR3Ocgco8kD9NheWVtIKmbTgDOJz1AnRvZN6WTSYci7wChkwGcSQ --description "vN"
```

Note that `clasp create` overwrites `appsscript.json` with a default manifest —
if you ever recreate the project, restore the `timeZone` and `webapp` blocks
before pushing, or the web app redeploys without anonymous access.

Changing the timezone means editing `apps-script/appsscript.json` **and**
re-running `clasp push` plus a redeploy — week boundaries are computed
server-side.
