/**
 * PRODUCTION TIME TRACKER — Google Apps Script API
 * =================================================
 * Backend for the GitHub Pages time-tracking app.
 * Storage: Google Sheets (event-sourced — only timestamped events are stored;
 * every metric is calculated from the event log).
 *
 * SETUP:
 *   1. Create a new Google Sheet.
 *   2. Extensions → Apps Script → paste this file.
 *   3. Run setupSheets() once (authorize when prompted).
 *   4. Fill the Employees sheet and set SUPERVISOR_PIN in the Config sheet.
 *   5. Deploy → New deployment → Web app:
 *        Execute as: Me        Who has access: Anyone
 *   6. Copy the /exec URL into CONFIG.API_URL in index.html and supervisor.html.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var SHEET_EVENTS = 'Events';
var SHEET_EMPLOYEES = 'Employees';
var SHEET_CONFIG = 'Config';

// Event → resulting state
var STATE_FROM_EVENT = {
  TIME_IN: 'WORKING',
  TIME_OUT: 'LOGGED_OUT',
  BREAK_START: 'BREAK',
  BREAK_END: 'WORKING',
  LUNCH_START: 'LUNCH',
  LUNCH_END: 'WORKING',
  BIO_START: 'BIO',
  BIO_END: 'WORKING',
  LOCKER_START: 'LOCKER',
  LOCKER_END: 'WORKING'
};

// State → allowed next actions (server-side validation of the state machine)
var VALID_ACTIONS = {
  NOT_STARTED: ['TIME_IN'],
  LOGGED_OUT: ['TIME_IN'],
  WORKING: ['BREAK_START', 'LUNCH_START', 'BIO_START', 'LOCKER_START', 'TIME_OUT'],
  BREAK: ['BREAK_END'],
  LUNCH: ['LUNCH_END'],
  BIO: ['BIO_END'],
  LOCKER: ['LOCKER_END']
};

// Pause categories: start/end pairs subtracted from logged time
var CATEGORIES = {
  BREAK: ['BREAK_START', 'BREAK_END'],
  LUNCH: ['LUNCH_START', 'LUNCH_END'],
  BIO: ['BIO_START', 'BIO_END'],
  LOCKER: ['LOCKER_START', 'LOCKER_END']
};

var CONFIG_DEFAULTS = {
  SUPERVISOR_PIN: '1234',        // change this in the Config sheet!
  MIN_PRODUCTION_HOURS: 7,       // biometric minimum presence in prod room
  SHIFT_LENGTH_HOURS: 9,         // e.g. 21:00 → 06:00
  BREAK_LIMIT_MIN: 15,
  LUNCH_LIMIT_MIN: 60,
  BIO_LIMIT_MIN: 30,             // total bio time per shift
  LOCKER_LIMIT_MIN: 15,
  FORGOT_TIMEOUT_HOURS: 16,      // shift open longer than this ⇒ "forgot to time out"
  ALERT_OFFFLOOR_MIN: 30,       // notify supervisor if someone is off-floor this long
  ALERT_EMAIL: '',              // supervisor email for notifications (blank = off)
  TELEGRAM_BOT_TOKEN: '',       // optional Telegram bot token (blank = off)
  TELEGRAM_CHAT_ID: ''          // optional Telegram chat/group id
};

// ---------------------------------------------------------------------------
// One-time setup
// ---------------------------------------------------------------------------

function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var ev = ss.getSheetByName(SHEET_EVENTS) || ss.insertSheet(SHEET_EVENTS);
  if (ev.getLastRow() === 0) {
    ev.appendRow(['Event ID', 'Timestamp', 'Employee ID', 'Employee Name', 'Action', 'Notes']);
    ev.setFrozenRows(1);
  }

  var emp = ss.getSheetByName(SHEET_EMPLOYEES) || ss.insertSheet(SHEET_EMPLOYEES);
  if (emp.getLastRow() === 0) {
    emp.appendRow(['Employee ID', 'Name', 'Active', 'Email']);
    emp.appendRow(['EMP01', 'John Reyes', 'TRUE', '']);
    emp.appendRow(['EMP02', 'Mary Santos', 'TRUE', '']);
    emp.setFrozenRows(1);
  }

  var cfg = ss.getSheetByName(SHEET_CONFIG) || ss.insertSheet(SHEET_CONFIG);
  if (cfg.getLastRow() === 0) {
    cfg.appendRow(['Key', 'Value']);
    Object.keys(CONFIG_DEFAULTS).forEach(function (k) {
      cfg.appendRow([k, CONFIG_DEFAULTS[k]]);
    });
    cfg.setFrozenRows(1);
  }

  // Optional: assigned break/lunch windows. Leave empty for fully flexible teams.
  // Off-window breaks are NEVER blocked — only flagged on the supervisor dashboard.
  var sch = ss.getSheetByName('Schedule') || ss.insertSheet('Schedule');
  if (sch.getLastRow() === 0) {
    sch.appendRow(['Employee ID', 'Type (LUNCH or BREAK)', 'Start (HH:mm)', 'End (HH:mm)']);
    sch.appendRow(['EMP01', 'LUNCH', '01:00', '02:00']);
    sch.appendRow(['EMP01', 'BREAK', '23:30', '23:45']);
    sch.setFrozenRows(1);
  }

  // Biometric reconciliation: paste the official biometric export here.
  // Date = the shift's start date (yyyy-MM-dd). Hours = biometric room-presence hours.
  var bio = ss.getSheetByName('Biometric') || ss.insertSheet('Biometric');
  if (bio.getLastRow() === 0) {
    bio.appendRow(['Date (yyyy-MM-dd)', 'Employee ID', 'Biometric Hours']);
    bio.setFrozenRows(1);
  }
}

// ---------------------------------------------------------------------------
// HTTP entry points
// ---------------------------------------------------------------------------

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    switch (p.action) {
      case 'ping':      return json({ ok: true, time: new Date().toISOString() });
      case 'employees': return json({ ok: true, employees: getEmployees() });
      case 'status':    return json(getEmployeeStatus(p.id));
      case 'floor':     return json(getFloorCount());                       // no PIN — count only, no names
      case 'week':      return json(getMyWeek(p.id));                       // employee's own last 7 shifts
      case 'team':      requirePin(p.pin); return json(getTeamStatus());
      case 'summary':   requirePin(p.pin); return json(getDailySummary(p.date));
      case 'reconcile': requirePin(p.pin); return json(getReconciliation(p.date));
      case 'stats':     requirePin(p.pin); return json(getMonthlyStats(p.month));
      case 'agentPins': requirePin(p.pin); return json(getAgentPins());
      default:          return json({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) });
  }
}

/**
 * POST body (sent as text/plain to avoid a CORS preflight):
 * { "action":"logEvent", "eventId":"uuid", "employeeId":"EMP01",
 *   "eventType":"TIME_IN", "clientTimestamp":"2026-06-10T08:00:00.000Z" }
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000); // serialize writes — prevents duplicate IDs / race conditions
  try {
    var body = JSON.parse(e.postData.contents);
    switch (body.action) {
      case 'logEvent':    return json(logEvent(body));
      case 'addEvent':    requirePin(body.pin); return json(supervisorAddEvent(body));
      case 'editEvent':   requirePin(body.pin); return json(supervisorEditEvent(body));
      case 'deleteEvent': requirePin(body.pin); return json(supervisorDeleteEvent(body));
      case 'setAgentPin': return json(setAgentPin(body));
      case 'resetAgentPin': requirePin(body.pin); return json(resetAgentPin(body));
      case 'emailAgents':  requirePin(body.pin); return json(emailAgents(body));
      default:            return json({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Core: event logging with validation + idempotency
// ---------------------------------------------------------------------------

function logEvent(body) {
  var employeeId = String(body.employeeId || '').trim();
  var eventType = String(body.eventType || '').trim();
  var eventId = String(body.eventId || Utilities.getUuid());

  if (!STATE_FROM_EVENT.hasOwnProperty(eventType)) {
    return { ok: false, error: 'Invalid event type: ' + eventType };
  }
  var employee = findEmployee(employeeId);
  if (!employee) return { ok: false, error: 'Unknown employee: ' + employeeId };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_EVENTS);
  var events = readEvents(sheet);

  // Idempotency: offline clients may retry — the same eventId is recorded once.
  for (var i = 0; i < events.length; i++) {
    if (events[i].eventId === eventId) {
      return { ok: true, duplicate: true, state: deriveState(events, employeeId).state };
    }
  }

  // State-machine validation
  var current = deriveState(events, employeeId);
  if (VALID_ACTIONS[current.state].indexOf(eventType) === -1) {
    return {
      ok: false,
      error: eventType + ' is not allowed from state ' + current.state,
      state: current.state,
      validActions: VALID_ACTIONS[current.state]
    };
  }

  // Timestamp: trust the client's clock for offline-queued events (so the
  // moment of the tap is preserved), but never accept a future time.
  var ts = body.clientTimestamp ? new Date(body.clientTimestamp) : new Date();
  if (isNaN(ts.getTime()) || ts.getTime() > Date.now() + 60000) ts = new Date();

  sheet.appendRow([eventId, ts, employeeId, employee.name, eventType, body.notes || '']);

  return {
    ok: true,
    eventId: eventId,
    timestamp: ts.toISOString(),
    state: STATE_FROM_EVENT[eventType],
    validActions: VALID_ACTIONS[STATE_FROM_EVENT[eventType]]
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function readEvents(sheet) {
  sheet = sheet || SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_EVENTS);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var rows = sheet.getRange(2, 1, last - 1, 6).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var ts = rows[i][1] instanceof Date ? rows[i][1] : new Date(rows[i][1]);
    if (isNaN(ts.getTime())) continue;
    out.push({
      eventId: String(rows[i][0]),
      ts: ts,
      employeeId: String(rows[i][2]),
      name: String(rows[i][3]),
      action: String(rows[i][4])
    });
  }
  out.sort(function (a, b) { return a.ts - b.ts; });
  return out;
}

function getEmployees() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_EMPLOYEES);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var numCols = Math.min(sheet.getLastColumn(), 4); // ID, Name, Active, Email (col 4 optional)
  return sheet.getRange(2, 1, last - 1, numCols).getValues()
    .filter(function (r) { return r[0] && String(r[2]).toUpperCase() !== 'FALSE'; })
    .map(function (r) { return { id: String(r[0]), name: String(r[1]), email: String(r[3] || '') }; });
}

function findEmployee(id) {
  var all = getEmployees();
  for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
  return null;
}

function getConfig() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CONFIG);
  var cfg = JSON.parse(JSON.stringify(CONFIG_DEFAULTS));
  if (!sheet || sheet.getLastRow() < 2) return cfg;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(function (r) {
    if (r[0]) cfg[String(r[0])] = r[1];
  });
  return cfg;
}

function requirePin(pin) {
  var expected = String(getConfig().SUPERVISOR_PIN);
  if (String(pin || '') !== expected) throw new Error('Invalid supervisor PIN');
}

// ---------------------------------------------------------------------------
// Schedule (optional assigned break/lunch windows — informational only)
// ---------------------------------------------------------------------------

function getSchedule() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Schedule');
  var map = {};
  if (!sheet || sheet.getLastRow() < 2) return map;
  var tz = Session.getScriptTimeZone();
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues().forEach(function (r) {
    if (!r[0] || !r[1]) return;
    var id = String(r[0]).trim();
    (map[id] = map[id] || []).push({
      type: String(r[1]).toUpperCase().indexOf('LUNCH') >= 0 ? 'LUNCH' : 'BREAK',
      start: cellToHHMM(r[2], tz),
      end: cellToHHMM(r[3], tz)
    });
  });
  return map;
}
function cellToHHMM(v, tz) {
  return v instanceof Date ? Utilities.formatDate(v, tz, 'HH:mm') : String(v).trim();
}
function toMin(hhmm) {
  var p = String(hhmm).split(':');
  return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0);
}
/** True if `date` falls inside any window of `type`. Windows may cross midnight
 *  (e.g. 23:50–00:10). If no windows of that type exist, returns true (no flag). */
function inAnyWindow(windows, type, date, tz) {
  var relevant = (windows || []).filter(function (w) { return w.type === type; });
  if (!relevant.length) return true;
  var nowMin = toMin(Utilities.formatDate(date, tz, 'HH:mm'));
  return relevant.some(function (w) {
    var s = toMin(w.start), e = toMin(w.end);
    return s <= e ? (nowMin >= s && nowMin <= e) : (nowMin >= s || nowMin <= e);
  });
}

// ---------------------------------------------------------------------------
// Live current-shift stats (millisecond precision, for the 7h target)
// ---------------------------------------------------------------------------

/** Returns null if the employee has no open shift right now. */
function getCurrentShiftStats(events, employeeId, now) {
  var mine = events.filter(function (e) { return e.employeeId === employeeId; });
  if (!mine.length) return null;
  var shifts = buildShifts(mine, now);
  var shift = shifts[shifts.length - 1];
  if (!shift || shift.timeOut || shift.orphan) return null;

  var loggedMs = Math.max(0, now - shift.timeIn);
  var pauseMs = 0;
  Object.keys(CATEGORIES).forEach(function (cat) {
    var startA = CATEGORIES[cat][0], endA = CATEGORIES[cat][1], open = null;
    shift.events.forEach(function (ev) {
      if (ev.action === startA) open = ev.ts;
      else if (ev.action === endA && open) { pauseMs += ev.ts - open; open = null; }
    });
    if (open) pauseMs += Math.max(0, now - open);
  });
  return {
    shiftStart: shift.timeIn.toISOString(),
    loggedMs: loggedMs,
    nonProductionMs: pauseMs,
    productionMs: Math.max(0, loggedMs - pauseMs)
  };
}

// ---------------------------------------------------------------------------
// State derivation — an employee's state is simply the result of their last event
// ---------------------------------------------------------------------------

function deriveState(events, employeeId) {
  var lastEvent = null;
  for (var i = events.length - 1; i >= 0; i--) {
    if (events[i].employeeId === employeeId) { lastEvent = events[i]; break; }
  }
  if (!lastEvent) return { state: 'NOT_STARTED', since: null };
  return {
    state: STATE_FROM_EVENT[lastEvent.action] || 'NOT_STARTED',
    since: lastEvent.ts.toISOString(),
    lastAction: lastEvent.action
  };
}

function getEmployeeStatus(id) {
  var employee = findEmployee(id);
  if (!employee) return { ok: false, error: 'Unknown employee: ' + id };
  var events = readEvents();
  var s = deriveState(events, id);
  var now = new Date();
  var cfg = getConfig();
  return {
    ok: true,
    employee: employee,
    state: s.state,
    since: s.since,
    validActions: VALID_ACTIONS[s.state],
    shift: getCurrentShiftStats(events, id, now),
    schedule: getSchedule()[id] || [],
    targets: {
      minProductionHours: Number(cfg.MIN_PRODUCTION_HOURS),
      shiftLengthHours: Number(cfg.SHIFT_LENGTH_HOURS)
    },
    generatedAt: now.toISOString()
  };
}

// ---------------------------------------------------------------------------
// Supervisor: live team status
// ---------------------------------------------------------------------------

function getTeamStatus() {
  var events = readEvents();
  var cfg = getConfig();
  var schedule = getSchedule();
  var tz = Session.getScriptTimeZone();
  var nowDate = new Date();
  var now = nowDate.getTime();
  var targetMs = Number(cfg.MIN_PRODUCTION_HOURS) * 3600000;
  var shiftLenMs = Number(cfg.SHIFT_LENGTH_HOURS) * 3600000;

  var team = getEmployees().map(function (emp) {
    var empEvents = events.filter(function(e){ return e.employeeId === emp.id; });
    var s = deriveState(events, emp.id);
    var minutes = s.since ? Math.floor((now - new Date(s.since).getTime()) / 60000) : null;
    var alerts = liveAlerts(s.state, minutes, cfg);
    var stats = getCurrentShiftStats(events, emp.id, nowDate);
    var byEmp = {}; byEmp[emp.id] = empEvents;

    // Off-schedule break/lunch (informational — never blocked)
    if ((s.state === 'BREAK' || s.state === 'LUNCH') &&
        !inAnyWindow(schedule[emp.id], s.state, nowDate, tz)) {
      alerts.push('Outside scheduled ' + s.state.toLowerCase() + ' window');
    }

    // 7h-target risk: even working non-stop until scheduled shift end won't reach it
    if (stats && s.state !== 'LOGGED_OUT') {
      var remainingMs = Math.max(0, new Date(stats.shiftStart).getTime() + shiftLenMs - now);
      if (stats.productionMs + remainingMs < targetMs) {
        alerts.push('Cannot reach ' + cfg.MIN_PRODUCTION_HOURS + 'h by scheduled shift end');
      }
    }

    return {
      id: emp.id,
      name: emp.name,
      state: s.state,
      since: s.since,
      minutesInState: minutes,
      productionMs: stats ? stats.productionMs : null,
      targetMet: stats ? stats.productionMs >= targetMs : null,
      shiftStart: stats ? stats.shiftStart : null,
      shiftEvents: getShiftEvents(byEmp[emp.id] || [], nowDate),
      alerts: alerts
    };
  });
  return {
    ok: true, team: team, generatedAt: nowDate.toISOString(),
    targetHours: Number(cfg.MIN_PRODUCTION_HOURS), config: cfg,
    floor: {
      onFloor: team.filter(function (e) { return e.state === 'WORKING'; }).length,
      offFloor: team.filter(function (e) { return ['BREAK','LUNCH','BIO','LOCKER'].indexOf(e.state) >= 0; }).length,
      loggedIn: team.filter(function (e) { return e.state !== 'LOGGED_OUT' && e.state !== 'NOT_STARTED'; }).length
    }
  };
}

/** Returns [{ts, action}] for the current open shift — used by the supervisor timeline. */
function getShiftEvents(empEvents, now) {
  var shifts = buildShifts(empEvents, now);
  if (!shifts.length) return [];
  var last = shifts[shifts.length - 1];
  if (last.timeOut) return []; // closed shift — client won't need it
  return last.events.map(function(ev){ return { ts: ev.ts.toISOString(), action: ev.action }; });
}

function liveAlerts(state, minutes, cfg) {
  var alerts = [];
  if (minutes === null) return alerts;
  if (state === 'BREAK' && minutes > Number(cfg.BREAK_LIMIT_MIN)) alerts.push('Break over ' + cfg.BREAK_LIMIT_MIN + ' min');
  if (state === 'LUNCH' && minutes > Number(cfg.LUNCH_LIMIT_MIN)) alerts.push('Lunch over ' + cfg.LUNCH_LIMIT_MIN + ' min');
  if (state === 'BIO' && minutes > Number(cfg.BIO_LIMIT_MIN)) alerts.push('Bio break over ' + cfg.BIO_LIMIT_MIN + ' min');
  if (state === 'LOCKER' && minutes > Number(cfg.LOCKER_LIMIT_MIN)) alerts.push('Locker break over ' + cfg.LOCKER_LIMIT_MIN + ' min');
  if (state !== 'WORKING' && state !== 'LOGGED_OUT' && state !== 'NOT_STARTED' &&
      minutes > Number(cfg.LUNCH_LIMIT_MIN) * 2) alerts.push('Possibly forgot to return');
  if (state === 'WORKING' && minutes > Number(cfg.FORGOT_TIMEOUT_HOURS) * 60) alerts.push('Possibly forgot to time out');
  return alerts;
}

// ---------------------------------------------------------------------------
// Supervisor: daily summary (handles overnight shifts)
// ---------------------------------------------------------------------------
//
// PRODUCTION TIME FORMULA
//   loggedMs     = TIME_OUT − TIME_IN            (now if shift still open)
//   pauseMs(cat) = Σ (CAT_END − CAT_START)       (open pauses capped at now)
//   productionMs = loggedMs − Σ pauseMs(all categories)
//
// A shift belongs to the calendar date of its TIME_IN (script timezone),
// so a 22:00 → 06:00 overnight shift is reported on the day it started.

function getDailySummary(dateStr) {
  var tz = Session.getScriptTimeZone();
  var targetDate = dateStr || Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var events = readEvents();
  var cfg = getConfig();
  var now = new Date();

  var byEmployee = {};
  events.forEach(function (ev) {
    (byEmployee[ev.employeeId] = byEmployee[ev.employeeId] || []).push(ev);
  });

  var rows = [];
  getEmployees().forEach(function (emp) {
    var shifts = buildShifts(byEmployee[emp.id] || [], now);
    shifts.forEach(function (shift) {
      if (Utilities.formatDate(shift.timeIn, tz, 'yyyy-MM-dd') !== targetDate) return;
      rows.push(summarizeShift(emp, shift, cfg, tz));
    });
  });

  // Team-level metrics
  var totals = {
    employeesLoggedIn: rows.length,
    avgProductionHours: rows.length
      ? round2(rows.reduce(function (s, r) { return s + r.productionHours; }, 0) / rows.length)
      : 0,
    totalNonProductionHours: round2(rows.reduce(function (s, r) {
      return s + r.breakHours + r.lunchHours + r.bioHours + r.lockerHours;
    }, 0))
  };

  return { ok: true, date: targetDate, rows: rows, totals: totals,
           targetHours: Number(cfg.MIN_PRODUCTION_HOURS), generatedAt: now.toISOString() };
}

/** Groups one employee's chronological events into shifts (TIME_IN → TIME_OUT). */
function buildShifts(events, now) {
  var shifts = [];
  var current = null;
  events.forEach(function (ev) {
    if (ev.action === 'TIME_IN') {
      if (current) { current.missingPairs.push('TIME_OUT missing before next TIME_IN'); shifts.push(current); }
      current = { timeIn: ev.ts, timeOut: null, events: [], missingPairs: [] };
    } else if (!current) {
      // event with no open shift — orphan (e.g. BREAK_END without TIME_IN)
      shifts.push({ timeIn: ev.ts, timeOut: ev.ts, events: [ev], missingPairs: ['Event without TIME_IN: ' + ev.action], orphan: true });
    } else if (ev.action === 'TIME_OUT') {
      current.timeOut = ev.ts;
      shifts.push(current);
      current = null;
    } else {
      current.events.push(ev);
    }
  });
  if (current) shifts.push(current); // still-open shift: capped at `now` in summarizeShift
  return shifts;
}

function summarizeShift(emp, shift, cfg, tz) {
  var end = shift.timeOut || new Date();
  var loggedMs = Math.max(0, end - shift.timeIn);
  var pause = { BREAK: 0, LUNCH: 0, BIO: 0, LOCKER: 0 };
  var counts = { BREAK: 0, LUNCH: 0, BIO: 0, LOCKER: 0 };
  var missing = shift.missingPairs.slice();

  Object.keys(CATEGORIES).forEach(function (cat) {
    var startAction = CATEGORIES[cat][0], endAction = CATEGORIES[cat][1];
    var openStart = null;
    shift.events.forEach(function (ev) {
      if (ev.action === startAction) {
        if (openStart) missing.push(cat + ' END missing');
        openStart = ev.ts;
      } else if (ev.action === endAction) {
        if (!openStart) { missing.push(cat + ' START missing'); return; }
        pause[cat] += ev.ts - openStart;
        counts[cat]++;
        openStart = null;
      }
    });
    if (openStart) { // still on this pause — count time up to now / shift end
      pause[cat] += Math.max(0, end - openStart);
      counts[cat]++;
      if (shift.timeOut) missing.push(cat + ' END missing');
    }
  });

  var totalPause = pause.BREAK + pause.LUNCH + pause.BIO + pause.LOCKER;
  var productionMs = Math.max(0, loggedMs - totalPause);

  var alerts = missing.slice();
  if (msToMin(pause.LUNCH) > Number(cfg.LUNCH_LIMIT_MIN)) alerts.push('Lunch exceeded limit');
  if (msToMin(pause.BREAK) > Number(cfg.BREAK_LIMIT_MIN) * Math.max(1, counts.BREAK)) alerts.push('Break time exceeded limit');
  if (msToMin(pause.BIO) > Number(cfg.BIO_LIMIT_MIN)) alerts.push('Bio total exceeded limit');
  if (msToMin(pause.LOCKER) > Number(cfg.LOCKER_LIMIT_MIN)) alerts.push('Locker total exceeded limit');
  if (!shift.timeOut && !shift.orphan && (new Date() - shift.timeIn) > Number(cfg.FORGOT_TIMEOUT_HOURS) * 3600000) {
    alerts.push('No TIME_OUT recorded');
  }
  if (shift.timeOut && productionMs < Number(cfg.MIN_PRODUCTION_HOURS) * 3600000) {
    alerts.push('Below ' + cfg.MIN_PRODUCTION_HOURS + 'h production minimum');
  }

  return {
    employeeId: emp.id,
    employeeName: emp.name,
    timeIn: Utilities.formatDate(shift.timeIn, tz, 'HH:mm'),
    timeOut: shift.timeOut ? Utilities.formatDate(shift.timeOut, tz, 'HH:mm') : '—',
    open: !shift.timeOut,
    loggedHours: msToH(loggedMs),
    productionHours: msToH(productionMs),
    breakHours: msToH(pause.BREAK),
    lunchHours: msToH(pause.LUNCH),
    bioHours: msToH(pause.BIO),
    lockerHours: msToH(pause.LOCKER),
    alerts: alerts
  };
}

function msToH(ms) { return round2(ms / 3600000); }
function msToMin(ms) { return ms / 60000; }
function round2(n) { return Math.round(n * 100) / 100; }

// ===========================================================================
// v3 FEATURES
// ===========================================================================

// --- Floor count (no PIN; count only, never names — safe for employee app) ---
function getFloorCount() {
  var events = readEvents();
  var onFloor = 0, offFloor = 0, loggedIn = 0;
  getEmployees().forEach(function (emp) {
    var st = deriveState(events, emp.id).state;
    if (st === 'WORKING') { onFloor++; loggedIn++; }
    else if (['BREAK','LUNCH','BIO','LOCKER'].indexOf(st) >= 0) { offFloor++; loggedIn++; }
  });
  return { ok: true, onFloor: onFloor, offFloor: offFloor, loggedIn: loggedIn };
}

// --- Employee's own last 7 shift-days ---
function getMyWeek(id) {
  var employee = findEmployee(id);
  if (!employee) return { ok: false, error: 'Unknown employee: ' + id };
  var tz = Session.getScriptTimeZone();
  var cfg = getConfig();
  var now = new Date();
  var mine = readEvents().filter(function (e) { return e.employeeId === id; });
  var shifts = buildShifts(mine, now);

  var days = shifts.map(function (shift) {
    var s = summarizeShift(employee, shift, cfg, tz);
    s.date = Utilities.formatDate(shift.timeIn, tz, 'yyyy-MM-dd');
    s.metTarget = !s.open && s.productionHours >= Number(cfg.MIN_PRODUCTION_HOURS);
    return s;
  }).sort(function (a, b) { return a.date < b.date ? 1 : -1; }).slice(0, 7);

  return { ok: true, employee: employee, days: days,
           targetHours: Number(cfg.MIN_PRODUCTION_HOURS) };
}

// --- Biometric reconciliation (app production vs official biometric hours) ---
function getBiometric() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Biometric');
  var map = {}; // key "date|id" -> hours
  if (!sheet || sheet.getLastRow() < 2) return map;
  var tz = Session.getScriptTimeZone();
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues().forEach(function (r) {
    if (!r[0] || !r[1]) return;
    var d = r[0] instanceof Date ? Utilities.formatDate(r[0], tz, 'yyyy-MM-dd') : String(r[0]).trim();
    map[d + '|' + String(r[1]).trim()] = Number(r[2]) || 0;
  });
  return map;
}

function getReconciliation(dateStr) {
  var summary = getDailySummary(dateStr);
  var bio = getBiometric();
  var rows = summary.rows.map(function (r) {
    var bioHours = bio[summary.date + '|' + r.employeeId];
    var hasBio = bioHours !== undefined;
    var delta = hasBio ? round2(r.productionHours - bioHours) : null;
    return {
      employeeId: r.employeeId, employeeName: r.employeeName,
      appHours: r.productionHours,
      bioHours: hasBio ? round2(bioHours) : null,
      delta: delta,
      flag: hasBio && Math.abs(delta) >= 0.5   // 30+ min mismatch ⇒ someone isn't tapping
    };
  });
  return { ok: true, date: summary.date, rows: rows,
           hasBiometric: Object.keys(bio).length > 0 };
}

// --- Monthly stats (per-employee averages + target hit-rate) ---
function getMonthlyStats(monthStr) {
  var tz = Session.getScriptTimeZone();
  var month = monthStr || Utilities.formatDate(new Date(), tz, 'yyyy-MM'); // yyyy-MM
  var cfg = getConfig();
  var target = Number(cfg.MIN_PRODUCTION_HOURS);
  var now = new Date();
  var events = readEvents();

  var byEmp = {};
  events.forEach(function (e) { (byEmp[e.employeeId] = byEmp[e.employeeId] || []).push(e); });

  var rows = [];
  getEmployees().forEach(function (emp) {
    var shifts = buildShifts(byEmp[emp.id] || [], now);
    var prod = [], met = 0, nonProd = 0, n = 0;
    shifts.forEach(function (shift) {
      if (shift.timeOut == null || shift.orphan) return;
      if (Utilities.formatDate(shift.timeIn, tz, 'yyyy-MM') !== month) return;
      var s = summarizeShift(emp, shift, cfg, tz);
      prod.push(s.productionHours);
      nonProd += s.breakHours + s.lunchHours + s.bioHours + s.lockerHours;
      if (s.productionHours >= target) met++;
      n++;
    });
    if (!n) return;
    var avg = prod.reduce(function (a, b) { return a + b; }, 0) / n;
    rows.push({
      employeeId: emp.id, employeeName: emp.name, shifts: n,
      avgProductionHours: round2(avg),
      avgNonProductionHours: round2(nonProd / n),
      targetHitRate: Math.round(met / n * 100),
      totalProductionHours: round2(prod.reduce(function (a, b) { return a + b; }, 0))
    });
  });
  rows.sort(function (a, b) { return b.avgProductionHours - a.avgProductionHours; });
  return { ok: true, month: month, rows: rows, targetHours: target };
}

// --- Supervisor corrections (manual add / edit / delete, with audit note) ---
function findEventRow(sheet, eventId) {
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(eventId)) return i + 2;
  return -1;
}

function supervisorAddEvent(body) {
  var employee = findEmployee(String(body.employeeId || '').trim());
  if (!employee) return { ok: false, error: 'Unknown employee' };
  if (!STATE_FROM_EVENT.hasOwnProperty(body.eventType)) return { ok: false, error: 'Invalid event type' };
  var ts = new Date(body.timestamp);
  if (isNaN(ts.getTime())) return { ok: false, error: 'Invalid timestamp' };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_EVENTS);
  var note = '[SUP-ADD] ' + (body.note || '') + ' @' + new Date().toISOString();
  sheet.appendRow([Utilities.getUuid(), ts, employee.id, employee.name, body.eventType, note]);
  return { ok: true };
}

function supervisorEditEvent(body) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_EVENTS);
  var row = findEventRow(sheet, body.eventId);
  if (row < 0) return { ok: false, error: 'Event not found' };
  var ts = new Date(body.timestamp);
  if (isNaN(ts.getTime())) return { ok: false, error: 'Invalid timestamp' };
  var oldNote = sheet.getRange(row, 6).getValue();
  sheet.getRange(row, 2).setValue(ts);
  if (body.eventType && STATE_FROM_EVENT.hasOwnProperty(body.eventType)) sheet.getRange(row, 5).setValue(body.eventType);
  sheet.getRange(row, 6).setValue('[SUP-EDIT] ' + (body.note || '') + ' @' + new Date().toISOString() + ' | was: ' + oldNote);
  return { ok: true };
}

function supervisorDeleteEvent(body) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_EVENTS);
  var row = findEventRow(sheet, body.eventId);
  if (row < 0) return { ok: false, error: 'Event not found' };
  sheet.deleteRow(row);
  return { ok: true };
}

// ===========================================================================
// EMAIL AGENTS — supervisor sends each agent their personal link + current PIN
// Requires supervisor PIN. Called via POST { action:'emailAgents', pin, baseUrl, includePin }
// baseUrl: the deployed index.html URL (e.g. https://user.github.io/repo/index.html)
// includePin: true|false — whether to include the agent's current PIN in the email
// ===========================================================================

function emailAgents(body) {
  var baseUrl = String(body.baseUrl || '').trim();
  if (!baseUrl) return { ok: false, error: 'baseUrl is required' };
  var includePin = body.includePin !== false; // default true
  var targetId   = body.employeeId ? String(body.employeeId).trim() : null; // optional: single agent

  var employees = getEmployees();
  if (targetId) employees = employees.filter(function(e){ return e.id === targetId; });

  var cfg = getConfig();
  var pins = {};
  var cfgSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CONFIG);
  if (cfgSheet && cfgSheet.getLastRow() >= 2) {
    cfgSheet.getRange(2, 1, cfgSheet.getLastRow() - 1, 2).getValues().forEach(function(r) {
      var k = String(r[0]);
      if (k.indexOf('AGENT_PIN_') === 0) pins[k.slice('AGENT_PIN_'.length)] = String(r[1]);
    });
  }

  var sent = [], skipped = [];
  employees.forEach(function(emp) {
    var email = emp.email ? emp.email.trim() : '';
    if (!email || email.indexOf('@') === -1) { skipped.push({ id: emp.id, name: emp.name, reason: 'no email' }); return; }

    var link = baseUrl + (baseUrl.indexOf('?') === -1 ? '?' : '&') + 'id=' + encodeURIComponent(emp.id);
    var pinLine = '';
    if (includePin) {
      var p = pins[emp.id] || '';
      pinLine = p
        ? '\nYour PIN: ' + p + '\n(Keep this private — you\'ll need it every time you clock in.)'
        : '\nYou haven\'t set a PIN yet. You\'ll be prompted to create one on your first clock-in.';
    }

    var subject = 'Your ProdTracker link';
    var body_text =
      'Hi ' + emp.name + ',\n\n' +
      'Here is your personal ProdTracker link:\n' +
      link + '\n' +
      pinLine + '\n\n' +
      'Bookmark it or add it to your Home Screen for quick access.\n\n' +
      '— Your Supervisor';

    try {
      MailApp.sendEmail({ to: email, subject: subject, body: body_text });
      sent.push({ id: emp.id, name: emp.name, email: email });
    } catch(err) {
      skipped.push({ id: emp.id, name: emp.name, reason: String(err.message || err) });
    }
  });

  return { ok: true, sent: sent, skipped: skipped };
}

// ===========================================================================
// NOTIFICATIONS — run checkAlerts() on a time-driven trigger (e.g. every 15 min)
// Triggers menu in Apps Script: add a time-driven trigger for checkAlerts.
// ===========================================================================

function checkAlerts() {
  var cfg = getConfig();
  var team = getTeamStatus().team;
  var props = PropertiesService.getScriptProperties();
  var sentToday = JSON.parse(props.getProperty('sentAlerts') || '{}');
  var todayKey = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (sentToday._day !== todayKey) sentToday = { _day: todayKey }; // reset daily

  var newMessages = [];
  team.forEach(function (e) {
    var offMin = (['BREAK','LUNCH','BIO','LOCKER'].indexOf(e.state) >= 0) ? e.minutesInState : 0;
    if (offMin >= Number(cfg.ALERT_OFFFLOOR_MIN)) {
      var key = e.id + ':offfloor:' + e.state;
      if (!sentToday[key]) { newMessages.push(e.name + ' off floor ' + offMin + ' min (' + e.state + ')'); sentToday[key] = true; }
    }
    e.alerts.forEach(function (a) {
      if (a.indexOf('Cannot reach') === 0) {
        var key2 = e.id + ':target';
        if (!sentToday[key2]) { newMessages.push(e.name + ': ' + a); sentToday[key2] = true; }
      }
    });
  });

  if (newMessages.length) {
    var text = 'Time Tracker alerts (' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm') + '):\n• ' + newMessages.join('\n• ');
    sendNotification(text, cfg);
  }
  props.setProperty('sentAlerts', JSON.stringify(sentToday));
}

function sendNotification(text, cfg) {
  cfg = cfg || getConfig();
  if (cfg.ALERT_EMAIL) {
    try { MailApp.sendEmail(String(cfg.ALERT_EMAIL), 'Time Tracker alert', text); } catch (err) {}
  }
  if (cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_CHAT_ID) {
    try {
      UrlFetchApp.fetch('https://api.telegram.org/bot' + cfg.TELEGRAM_BOT_TOKEN + '/sendMessage', {
        method: 'post',
        payload: { chat_id: String(cfg.TELEGRAM_CHAT_ID), text: text },
        muteHttpExceptions: true
      });
    } catch (err) {}
  }
}

// ===========================================================================
// ARCHIVE — run archiveOldEvents() on a monthly trigger.
// Moves events older than 45 days into Archive_YYYY_MM so the live sheet
// stays fast. State derivation only needs recent events.
// ===========================================================================

function archiveOldEvents() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_EVENTS);
  var last = sheet.getLastRow();
  if (last < 2) return;
  var cutoff = new Date(Date.now() - 45 * 86400000);
  var data = sheet.getRange(2, 1, last - 1, 6).getValues();
  var keep = [], archive = [];
  data.forEach(function (r) {
    var ts = r[1] instanceof Date ? r[1] : new Date(r[1]);
    (ts < cutoff ? archive : keep).push(r);
  });
  if (!archive.length) return;

  var tz = Session.getScriptTimeZone();
  var name = 'Archive_' + Utilities.formatDate(cutoff, tz, 'yyyy_MM');
  var arch = ss.getSheetByName(name) || ss.insertSheet(name);
  if (arch.getLastRow() === 0) arch.appendRow(['Event ID', 'Timestamp', 'Employee ID', 'Employee Name', 'Action', 'Notes']);
  arch.getRange(arch.getLastRow() + 1, 1, archive.length, 6).setValues(archive);

  sheet.getRange(2, 1, last - 1, 6).clearContent();
  if (keep.length) sheet.getRange(2, 1, keep.length, 6).setValues(keep);
}

// ===========================================================================
// AGENT PINs — stored in Config sheet as "AGENT_PIN_<employeeId>"
// ===========================================================================

/**
 * Returns a map of { employeeId: pin } for all agents.
 * Requires supervisor PIN.
 */
function getAgentPins() {
  var cfg = getConfig();
  var pins = {};
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CONFIG);
  if (!sheet || sheet.getLastRow() < 2) return { ok: true, pins: pins };
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(function (r) {
    var key = String(r[0]);
    if (key.indexOf('AGENT_PIN_') === 0) {
      var empId = key.slice('AGENT_PIN_'.length);
      pins[empId] = String(r[1]);
    }
  });
  return { ok: true, pins: pins };
}

/**
 * Verifies an agent's PIN (for logEvent validation).
 * Returns { ok: true } if matched, { ok: false, error } otherwise.
 * No supervisor PIN needed — agents call this.
 */
function verifyAgentPin(employeeId, pin) {
  var cfg = getConfig();
  var key = 'AGENT_PIN_' + String(employeeId);
  var stored = cfg[key] || '';
  if (!stored) return { ok: true, pinNotSet: true }; // No PIN set yet — allow, client handles setup
  return String(pin) === stored ? { ok: true } : { ok: false, error: 'Incorrect agent PIN' };
}

/**
 * Sets an agent's PIN. No supervisor PIN required — first-time set by agent.
 * If a PIN already exists, the old one must be provided (or supervisor PIN overrides).
 */
function setAgentPin(body) {
  var employeeId = String(body.employeeId || '').trim();
  if (!findEmployee(employeeId)) return { ok: false, error: 'Unknown employee' };
  var newPin = String(body.pin || '').trim();
  if (!/^\d{4}$/.test(newPin)) return { ok: false, error: 'PIN must be exactly 4 digits' };

  var cfg = getConfig();
  var key = 'AGENT_PIN_' + employeeId;
  var existing = String(cfg[key] || '');

  // Allow set if: no existing PIN, or correct old PIN provided, or supervisor PIN provided
  var supPin = String(getConfig().SUPERVISOR_PIN);
  var oldPin = String(body.oldPin || '');
  var supPinProvided = body.supervisorPin && String(body.supervisorPin) === supPin;

  if (existing && oldPin !== existing && !supPinProvided) {
    return { ok: false, error: 'Old PIN required to change PIN' };
  }

  // Write to Config sheet
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CONFIG);
  var last = sheet.getLastRow();
  if (last >= 2) {
    var keys = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i][0]) === key) {
        sheet.getRange(i + 2, 2).setValue(newPin);
        return { ok: true };
      }
    }
  }
  sheet.appendRow([key, newPin]);
  return { ok: true };
}

/**
 * Resets (deletes) an agent's PIN. Requires supervisor PIN.
 */
function resetAgentPin(body) {
  var employeeId = String(body.employeeId || '').trim();
  var key = 'AGENT_PIN_' + employeeId;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CONFIG);
  var last = sheet.getLastRow();
  if (last < 2) return { ok: true };
  var keys = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === key) {
      sheet.deleteRow(i + 2);
      return { ok: true };
    }
  }
  return { ok: true }; // Already not set
}
