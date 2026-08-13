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
3. Open it, tap the **gear**, paste the `/exec` URL above, tap **Save**.

Until a URL is saved the banner reads "Not connected"; Settings never opens by
itself.

The URL is stored in `localStorage`, so it is per-device — repeat step 3 on any
other phone or tablet.

## How tracking works

- **Tapping a tile always starts that task**, switching from whatever was
  running. Tapping the task that is already current re-asserts it rather than
  stopping — so a tap made because the display looked wrong cannot silently end
  the day.
- **End day** is the only control that stops the clock. It is disabled when
  nothing is running.
- A stop only ever closes what is actually running. If the day is already ended,
  a stop — a location trigger firing after you left, a stale tap — **records
  nothing**, rather than leaving an orphan row that pairs with nothing and
  counts as zero. The location automation can therefore never pad the totals;
  it can only rescue a day you forgot to end.
- A bar above the grid names the current task, and its tile is highlighted and
  marked "Current". There is no elapsed timer and no hours anywhere in the app:
  a clock that can drift or go stale invites corrections that log the wrong
  thing, and the numbers belong in the sheet.
- Only one task runs at a time: starting a new one **auto-stops** the previous
  one at the same instant, logged with source `auto-switch`.
- A task left running for **6 hours** is auto-stopped with source `auto-safety`,
  since the real stop was probably earlier and the logged time is likely an
  overestimate. Such a row is **shaded amber in the sheet** and carries a
  `Verified` checkbox. Correct its `Time`, then tick `Verified` and the shading
  clears. The hours themselves are never altered by ticking it. This lives in
  the sheet only — the app shows no hours and no review list.

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

## Markers

`action=mark` records a moment that is not part of timing anything — leaving the
building, say:

```
{exec}?action=mark&source=leave-clinic&note=Left%20the%20clinic
```

Neither the start/stop pairing nor the active-task lookup matches on `mark`, so
a marker **cannot alter an hours figure**, does not interrupt a running task,
and works whether or not something is running. It is simply a timestamped row
you can sort or filter on later. `note` is free text and becomes the row's Note.

## iPhone Shortcuts

`source` is free text, so give each trigger its own label (`shortcut`,
`leave-work`, `arrive-work`) and the Log records how every entry got there.

**A shortcut that calls the app:** Shortcuts → **+** → add **Get Contents of
URL** → paste one of the links below → Method **GET**. Use *Get Contents of URL*,
not *Open URLs*: it runs silently instead of launching Safari.

```
https://script.google.com/macros/s/AKfycbzeAjV9VK4Hw9OOpqyR3Ocgco8kD9NheWVtIKmbTgDOJz1AnRvZN6WTSYci7wChkwGcSQ/exec?action=start&task=clinic&source=shortcut
https://script.google.com/macros/s/AKfycbzeAjV9VK4Hw9OOpqyR3Ocgco8kD9NheWVtIKmbTgDOJz1AnRvZN6WTSYci7wChkwGcSQ/exec?action=stop&source=leave-work
```

**Stopping automatically when leaving work:** Shortcuts → **Automation** →
**+** → **Leave** → pick the work address → **Next** → **Run Shortcut** → choose
the stop shortcut. Then turn on **Run Immediately** and turn off **Ask Before
Running**, or it will sit waiting for a tap and never fire in your pocket.
Location automations need Location Services set to **Always**.

The geofence can lag by a few minutes, so the recorded stop is when the
automation fired, not when you walked out. If nothing is running the stop
writes no row at all, so a spurious trigger is harmless, and the 6h auto-stop
remains the backstop for a day the automation misses entirely.

**Starting the clinic day on arrival:** the same recipe with an **Arrive**
trigger and a start URL. Constrain it to working days and hours in the
automation itself (**Time Range**, and the day-of-week selector), or a Sunday
errand near the building opens a Clinic entry.

Arriving while a different task is running switches to Clinic and closes the
other one, which is usually what returning to the building means. Arriving when
Clinic is already running does nothing, so re-entering the geofence through the
day is harmless.

**Triggering a start by hand:** the same shortcut can be added to the Home
Screen (Share → Add to Home Screen), bound to **Back Tap** (Settings →
Accessibility → Touch → Back Tap), or put on the Action button. For all six
tasks in one shortcut, use a **Choose from Menu** action with a *Get Contents of
URL* under each branch.

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

Rebuilds are driven by a fingerprint of the log (an algorithm version, the row
count, and the sum of all row times), checked on every summary read. The
algorithm version is what forces a rebuild when a change to how hours are
computed would give a different answer for unchanged rows — without it the tab
would keep serving figures from superseded code. Anything that changes the log is
therefore picked up — including **deleting rows, which fires no trigger at all**
— while an unchanged log costs no write, so an idle app refreshing every 60
seconds never touches the sheet. An `onEdit` trigger additionally refreshes it
immediately after a hand-edit.

A session running past Sunday midnight is split across the two weeks rather than
counted wholly in one.

While a task is still running, its elapsed time lands in the current week's row
as of the last rebuild; it settles exactly when you end the day.

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

`Date` accepts `2026-08-11`, `8/11/2026`, `8/11/26` and written forms like
`Aug 11, 2026`. A blank `Time` means midnight.

Both columns are read from what Sheets *displays*, not from the underlying cell
value, so what you see in the cell is what gets counted. A date or time typed
into Sheets becomes a serial number whose `Date` form is anchored to the
spreadsheet's timezone; reading that directly shifted hand-entered rows by hours
and often onto the previous day.

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

# backend logic against a fake Sheets environment (127 checks).
# Run it in the project timezone — week boundaries are local-time.
TZ=America/Los_Angeles npm run test:backend

# frontend in a real browser against a mock backend (45 checks).
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
