# Production Time Tracker

A lightweight, mobile-first time tracking app for call center / operations teams.
Frontend on **GitHub Pages**, API on **Google Apps Script**, storage in **Google Sheets**.

## 1. Architecture

```
┌─────────────────────────┐         HTTPS (GET/POST)        ┌──────────────────────┐
│  GitHub Pages (static)  │ ──────────────────────────────▶ │  Google Apps Script  │
│  • index.html  (staff)  │ ◀────────────────────────────── │  Web App  (Code.gs)  │
│  • supervisor.html      │            JSON                 └──────────┬───────────┘
│  • localStorage queue   │                                            │ read/append
└─────────────────────────┘                                 ┌──────────▼───────────┐
                                                            │    Google Sheets     │
                                                            │ Events / Employees / │
                                                            │       Config         │
                                                            └──────────────────────┘
```

**Event sourcing:** the Events sheet is append-only and stores only timestamped
actions. Every status, total and alert is *calculated* from that log — nothing
derived is ever stored, so the data can never go out of sync.

**State machine (enforced on both client and server):**

```
NOT_STARTED ──TIME_IN──▶ WORKING ──TIME_OUT──▶ LOGGED_OUT ──TIME_IN──▶ WORKING
                           │  ▲
        BREAK_START/END    │  │   (same pattern for LUNCH, BIO, LOCKER)
                           ▼  │
                          BREAK
```

The employee UI only renders the actions valid for the current state, and the
server rejects anything else — an employee on lunch physically cannot record a
break.

## 2. Folder structure

```
time-tracker/
├── index.html              # employee app (single file: HTML+CSS+JS)
├── supervisor.html         # supervisor dashboard (PIN-protected)
├── apps-script/
│   └── Code.gs             # paste into Apps Script (not deployed to Pages)
└── README.md
```

## 3. Google Sheets schema

| Sheet       | Columns                                                        |
|-------------|----------------------------------------------------------------|
| `Events`    | Event ID (UUID) · Timestamp · Employee ID · Employee Name · Action · Notes |
| `Employees` | Employee ID · Name · Active (TRUE/FALSE)                        |
| `Config`    | Key · Value                                                     |

Actions: `TIME_IN, TIME_OUT, BREAK_START/END, LUNCH_START/END, BIO_START/END, LOCKER_START/END`

Config keys (editable any time, no redeploy needed):

| Key                  | Default | Meaning                                  |
|----------------------|---------|------------------------------------------|
| SUPERVISOR_PIN       | 1234    | **Change this immediately**              |
| BREAK_LIMIT_MIN      | 15      | per-break alert threshold                |
| LUNCH_LIMIT_MIN      | 60      | lunch alert threshold                    |
| BIO_LIMIT_MIN        | 30      | total bio time per shift                 |
| LOCKER_LIMIT_MIN     | 15      | total locker time per shift              |
| FORGOT_TIMEOUT_HOURS | 16      | open shift longer than this ⇒ alert      |

## 4. Production time formula

```
loggedTime     = TIME_OUT − TIME_IN                  (or `now` if shift is open)
pauseTime(cat) = Σ (CAT_END − CAT_START)             (open pauses capped at now)
productionTime = loggedTime − pause(BREAK) − pause(LUNCH) − pause(BIO) − pause(LOCKER)
```

**Overnight shifts:** events are paired chronologically, never by calendar day,
so a 22:00 → 06:00 shift computes correctly. Each shift is *reported* on the
date of its TIME_IN.

**Exception detection** (computed, shown in the Alerts column):
threshold breaches per category, "possibly forgot to return", "possibly forgot
to time out", and missing event pairs (e.g. a BREAK_END with no BREAK_START).

## 5. Offline support

Every tap gets a client-generated UUID and the tap's timestamp. If the network
is down, events queue in `localStorage` and the UI updates optimistically with
a "Saved offline · will sync" toast and a queue counter in the header. The queue
flushes on the `online` event and every 30 s. The server deduplicates by Event
ID, so retries can never create double entries, and the original tap time is
preserved.

Queue errors are classified: transient failures (network down, Apps Script
quota) are retried; permanent rejections (state-machine violation, wrong PIN,
unknown employee) are dropped with a visible warning toast so one bad event can
never block the queue forever.

The app also persists a **full shift snapshot** (state, shift start, production
so far, timeline events) locally, so reloading the page offline mid-shift
restores the ring, the production counter and the timeline — not just the
current state.

## 6. Deployment

### A. Backend (once)
1. Create a Google Sheet → **Extensions → Apps Script** → paste `apps-script/Code.gs`.
2. Run `setupSheets()` once and authorize. Three sheets appear.
3. Fill **Employees** (ID, Name, Active=TRUE) and change **SUPERVISOR_PIN** in Config.
4. **Deploy → New deployment → Web app**
   - Execute as: **Me** · Who has access: **Anyone**
5. Copy the `https://script.google.com/macros/s/…/exec` URL.

> After editing Code.gs later, use **Deploy → Manage deployments → Edit → New version**
> (a brand-new deployment changes the URL).

### B. Frontend (once)
1. Paste the `/exec` URL into `CONFIG.API_URL` near the top of the `<script>` in
   **both** `index.html` and `supervisor.html`.
2. Push this folder to a GitHub repo → **Settings → Pages → Deploy from branch**
   (main, root).
3. Your URLs:
   - Employee: `https://USER.github.io/REPO/?id=EMP01`  ← give each person their own link
   - Supervisor: `https://USER.github.io/REPO/supervisor.html`

### C. Rollout tips
- Send each employee their personal `?id=` link and have them **Add to Home
  Screen** — it then opens like an app, one tap from the home screen.
- The dropdown appears automatically if someone opens the page without an `id`.

## 7. Security model (lightweight, by design)

- Employees are identified by their personal `?id=` link **plus a 4-digit agent
  PIN that is verified server-side on every clock-in**. The agent sets the PIN
  on first clock-in; it's registered with the server, so it works on any device
  and shows up on the supervisor's PINs tab. A coworker who knows someone's
  link can no longer clock in for them without the PIN.
- Only `TIME_IN` is PIN-gated. Breaks/returns inside an open shift are not, so
  offline taps mid-shift always sync cleanly and the 8-taps-a-night flow stays
  frictionless.
- Lost PIN: the supervisor resets it from the **PINs** tab; the agent creates a
  new one at the next clock-in.
- The supervisor PIN is checked **server-side** on every team/summary request
  and is never embedded in the page. (It does travel in the request, so treat
  the Apps Script URL itself as internal.)
- The Apps Script runs as the sheet owner; the spreadsheet itself never needs
  to be shared with anyone.
- This is still an internal, low-stakes tool — not hardened for truly
  adversarial environments. The official record remains the biometric system.

## 8. Maintenance & scale

- 25–100 employees ≈ 800–1,500 rows/day. Apps Script reads the whole Events
  sheet per request, which stays fast for months. When the sheet passes
  ~100k rows, cut the old rows into an `Archive_YYYY` sheet (the app only needs
  recent events to derive state).
- All reporting beyond the dashboard can be done directly in Sheets — the
  event log is plain, analyzable data.

## 9. UI wireframes

```
EMPLOYEE (mobile)                      SUPERVISOR
┌──────────────────────┐   ┌──────────────────────────────────────┐
│ John · EMP01  ●online│   │ Team Time Tracker      Updated 14:02 │
│ ┌──────────────────┐ │   │ [Live status][Daily summary] [↻]     │
│ │   🟢 WORKING     │ │   │ ┌────┐┌────┐┌────┐┌────┐┌────┐       │
│ │    02:14:36      │ │   │ │ 24 ││ 19 ││ 3  ││ 2  ││ 1  │ chips │
│ │   since 08:00    │ │   │ └────┘└────┘└────┘└────┘└────┘       │
│ └──────────────────┘ │   │ Employee │Status │Since│For │Alerts  │
│ [BREAK ] [LUNCH    ] │   │ ▌Mary    │Lunch  │12:05│71m │Lunch>60│
│ [BIO   ] [LOCKER   ] │   │  John    │Working│08:00│6h2m│        │
│ [     TIME OUT     ] │   │  Paul    │Bio    │14:01│ 4m │        │
└──────────────────────┘   └──────────────────────────────────────┘
```

The whole employee screen tints to the current state's color (green working,
amber break, orange lunch…), so status is readable from across the room.

## 10. The 7-hour biometric minimum (v2)

The company's official record is biometric room presence (min 7h). This app is
the **self-management mirror** of that number:

- **Employee app** shows a live progress bar (`Production 4:30 / 7:00`) and a
  **break budget**: the pause time you can still take and reach 7h by the
  scheduled shift end. Math: `budget = (shiftStart + SHIFT_LENGTH − now) − (7h − productionSoFar)`.
  If you've overspent, it tells you the exact time you must stay until.
- **Supervisor live view** shows each person's production-so-far vs 7h and
  flags anyone who *cannot* reach 7h even working non-stop until shift end.
- **Daily summary** marks completed shifts below 7h in red.
- **Schedule sheet (optional):** assign LUNCH/BREAK windows per employee
  (windows may cross midnight, e.g. 23:50–00:10). Off-window breaks are never
  blocked — people finish their calls — they're just flagged on the dashboard.
  Leave the sheet empty for fully flexible teams.

⚠️ The app only matches biometrics if people tap when they actually leave/enter
the room. Coach the team: phone tap at the door, same as the badge scan.

## 11. Maxed-out feature set (v3)

**Employee app**
- **End-of-shift recap** — on TIME OUT, a card shows production hours, a ✓/✗
  against the 7h minimum, and the lunch/break/bio/locker breakdown.
- **My week** — last 7 shifts with hit/miss per night (button on the main screen).
- **Floor indicator** — while working, shows "18 on the floor · 3 off" so people
  can self-coordinate before stepping out (uses a no-PIN count-only endpoint).
- **Midpoint nudge** — one vibrate + toast at the halfway mark if pace won't reach 7h.

**Supervisor dashboard** (5 tabs)
- **Live status** — adds a prominent floor count and a "hit 7h target" chip.
- **Daily summary** — unchanged, plus CSV export.
- **Reconcile** — paste the biometric export into the Biometric sheet; this tab
  shows app-production vs biometric hours and flags deltas ≥ 30 min (who isn't tapping).
- **Stats** — per-employee monthly averages, 7h hit-rate, and a mini bar chart; CSV export.
- **Corrections** — add a missed event ("John forgot to tap lunch") with an audit
  note. Edits/deletes of existing rows are done in the Events sheet (Event ID in col A).

**Notifications** (optional, free)
- `checkAlerts()` sends email and/or Telegram when someone is off-floor past
  `ALERT_OFFFLOOR_MIN` or can't reach 7h. Set `ALERT_EMAIL` and/or
  `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` in Config. Add a **time-driven trigger**
  for `checkAlerts` (Apps Script → Triggers → every 15 min). De-duplicates per night.

**Maintenance**
- `archiveOldEvents()` moves events older than 45 days into an `Archive_YYYY_MM`
  sheet. Add a **monthly time-driven trigger** for it.

**PWA / install**
- `manifest.json` + `sw.js` make both pages installable to the home screen and
  load instantly offline. The service worker never caches API calls (always live);
  offline event capture stays in localStorage as before.

### Triggers to set up (Apps Script → Triggers → Add Trigger)
| Function          | Event source | Interval        | Purpose                    |
|-------------------|--------------|-----------------|----------------------------|
| `checkAlerts`     | Time-driven  | Every 15 min    | off-floor / target alerts  |
| `archiveOldEvents`| Time-driven  | Monthly         | keep Events sheet fast     |

### Deliberately not built
- GPS/geofencing (phones lie indoors; biometrics already verify presence)
- Hard-blocking off-schedule breaks (people are mid-call — flag, don't block)
- Employee passwords (friction kills adoption of an 8-taps-a-night tool)

## 12. Upgrade notes — 2026-06 hardening revision

**You must redeploy the backend:** Apps Script → paste the new `Code.gs` →
**Deploy → Manage deployments → Edit → New version** (do NOT create a new
deployment — that would change the URL). Then push the new frontend files.
The service worker cache was bumped to `tt-shell-v2`, so clients pick up the
new pages automatically on next load.

Fixed in this revision:

- **supervisor.html was completely broken** — a deleted function declaration
  (`dirCopyLink`) left a top-level SyntaxError, so the whole dashboard script
  never ran. Restored.
- **Agent PINs are now real.** Previously the PIN lived only in the agent's own
  browser and the server never checked it: anyone with a coworker's link could
  clock in as them from a fresh device, and the supervisor PINs tab always
  showed "Not set". Now the PIN is registered server-side on first clock-in,
  verified server-side on every `TIME_IN` (`pinError` responses roll back the
  optimistic UI and re-prompt), survives device changes, and the supervisor
  PINs tab / reset actually work.
- **PWA install was silently failing** if the icon files were missing, because
  `cache.addAll()` rejects on any 404 — no offline shell at all. Core files are
  now cached strictly and icons best-effort; `icon-192.png` / `icon-512.png`
  are now included in the repo.
- **Offline queue** no longer blocks forever on a permanently-rejected event
  (it's dropped with a visible warning); network errors still retry.
- **Offline reload mid-shift** now restores the full shift (ring, production,
  timeline) from a local snapshot instead of just the state label.
- **Timeline after reload**: the `status` API now returns the open shift's
  events, so the shift timeline no longer starts empty after a page refresh.
- **"Today" stats tab** showed the most recent shift even if it was last week,
  could crash on an open shift with no closed shift today, and duplicated the
  live shift as a "previous" card. All fixed; multiple closed shifts in one day
  now all display.
- **Hardening / polish**: `esc()` now escapes quotes; inline `onclick` handlers
  replaced with bound listeners; supervisor unlock and PIN reset surface errors
  instead of failing silently; stale heat strip hidden on non-Live tabs; CSV
  exports get a UTF-8 BOM so Excel opens names correctly; server marks
  permanent rejections with `permanent: true` for the client.
