# Shift Log

A phone-first time tracker for six task categories — Clinic, Lunch, Notes,
Inbox, Forms, Meeting — backed by a Google Sheet.

| Piece | Where |
| --- | --- |
| Web app (PWA) | https://shift-log.pages.dev |
| Backend (Apps Script web app) | `https://script.google.com/macros/s/AKfycbzeAjV9VK4Hw9OOpqyR3Ocgco8kD9NheWVtIKmbTgDOJz1AnRvZN6WTSYci7wChkwGcSQ/exec` |
| Data | Google Sheet "Shift Log", tab `Log` |

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
- A task left running for **6 hours** is auto-stopped with source `auto-safety`
  and listed under "Needs review" in the app, since the real stop was probably
  earlier and the logged time is likely an overestimate.
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

## Sheet columns

`Timestamp` · `Date` · `Time` · `Task` · `Action` · `Source` · `Note`

The `Log` tab and its header row are created automatically on first write.

## Correcting entries by hand

Edit the sheet directly — every total is recomputed from these rows on each
request, so there is no cached state to invalidate.

**`Timestamp` is the only column the math reads.** `Date` and `Time` are
human-readable copies kept for scanning the log; changing them alone does
nothing. The app writes local ISO-8601 with an explicit offset:

```
2026-08-11T16:50:14-07:00
└──┬───┘ ┬ └──┬───┘└──┬──┘
   │     │    │       └─ offset from UTC (-07:00 = Pacific Daylight Time)
   │     │    └───────── 24-hour clock: 16:50:14 is 4:50:14 pm
   │     └────────────── separator between the date and the time
   └──────────────────── year-month-day
```

When correcting a row you can type any of these instead — all are read as
project-local time unless they carry their own offset:

| You type | Means |
| --- | --- |
| `2026-08-11 16:50:00` | 4:50 pm local |
| `2026-08-11 16:50` | same; seconds optional |
| `2026-08-11T16:50:00` | same; `T` or a space both work |
| `2026-08-11` | midnight local |
| `2026-08-11T23:50:14.280Z` | UTC (the `Z`), which older rows use |

Rows are sorted by `Timestamp` before pairing, so a correction does **not**
need to be inserted in the right position — put it anywhere and the totals
come out right. Two rows sharing a timestamp keep their sheet order, which is
what makes an auto-switch's stop-then-start pair unambiguous.

Two rules still apply: `start` and `stop` must alternate for a task to be
paired, and if the chronologically last row is a `start`, the app treats that
task as currently running.

## Development

```sh
cd test && npm install

# backend logic against a fake Sheets environment (31 checks).
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
