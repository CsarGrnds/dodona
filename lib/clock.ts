// NYSE market hours, ported from /trader-alerts (market_status): weekends, the NYSE holiday list
// and 1:00 p.m. early closes for 2026–2027, in New York time. Pure and shared.

import { clockLabel, CLOSE_MIN, nyClock, OPEN_MIN } from "./setups";

export const NYSE_HOLIDAYS: Record<string, string> = {
  "2026-01-01": "New Year's Day",
  "2026-01-19": "Martin Luther King, Jr. Day",
  "2026-02-16": "Washington's Birthday",
  "2026-04-03": "Good Friday",
  "2026-05-25": "Memorial Day",
  "2026-06-19": "Juneteenth National Independence Day",
  "2026-07-03": "Independence Day (observed)",
  "2026-09-07": "Labor Day",
  "2026-11-26": "Thanksgiving Day",
  "2026-12-25": "Christmas Day",
  "2027-01-01": "New Year's Day",
  "2027-01-18": "Martin Luther King, Jr. Day",
  "2027-02-15": "Washington's Birthday",
  "2027-03-26": "Good Friday",
  "2027-05-31": "Memorial Day",
  "2027-06-18": "Juneteenth National Independence Day (observed)",
  "2027-07-05": "Independence Day (observed)",
  "2027-09-06": "Labor Day",
  "2027-11-25": "Thanksgiving Day",
  "2027-12-24": "Christmas Day (observed)",
};
export const NYSE_EARLY_CLOSE: Record<string, string> = {
  "2026-11-27": "day after Thanksgiving",
  "2026-12-24": "Christmas Eve",
  "2027-11-26": "day after Thanksgiving",
};
export const CALENDAR_YEARS = [2026, 2027];
const EARLY_MIN = 13 * 60;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function tradingDay(date: string): { ok: boolean; reason: string } {
  const wd = weekday(date);
  if (wd === 0 || wd === 6) return { ok: false, reason: "weekend" };
  const h = NYSE_HOLIDAYS[date];
  if (h) return { ok: false, reason: `NYSE holiday: ${h}` };
  return { ok: true, reason: "" };
}

/** Open and close in New York minutes after midnight, or null when closed all day. */
export function sessionHours(date: string): { open: number; close: number } | null {
  if (!tradingDay(date).ok) return null;
  return { open: OPEN_MIN, close: NYSE_EARLY_CLOSE[date] ? EARLY_MIN : CLOSE_MIN };
}

export interface MarketStatus {
  open: boolean;
  date: string; // New York date
  weekday: string;
  nowLabel: string; // e.g. "2:41 PM"
  reason: string; // "regular session", "before the open", "after the close", "weekend", "NYSE holiday: …"
  closesAt?: string; // today's close when open
  earlyClose?: string;
  nextOpen?: { date: string; weekday: string; label: string };
  calendarKnown: boolean;
}

export function marketStatus(nowMs: number): MarketStatus {
  const { date, minute } = nyClock(nowMs);
  const td = tradingDay(date);
  const s = sessionHours(date);
  const st: MarketStatus = {
    open: false,
    date,
    weekday: WEEKDAYS[weekday(date)],
    nowLabel: clockLabel(minute),
    reason: td.reason,
    earlyClose: NYSE_EARLY_CLOSE[date],
    calendarKnown: CALENDAR_YEARS.includes(Number(date.slice(0, 4))),
  };
  if (s) {
    if (minute >= s.open && minute < s.close) {
      st.open = true;
      st.reason = "regular session";
      st.closesAt = clockLabel(s.close);
    } else st.reason = minute < s.open ? "before the open" : "after the close";
  }
  let nd = s && minute < s.open ? date : addDays(date, 1);
  for (let i = 0; i < 15; i++) {
    if (sessionHours(nd)) {
      st.nextOpen = { date: nd, weekday: WEEKDAYS[weekday(nd)], label: clockLabel(OPEN_MIN) };
      break;
    }
    nd = addDays(nd, 1);
  }
  return st;
}

/** Trading sessions from `from` (exclusive) through `to` (inclusive), both New York dates. */
export function tradingDaysBetween(from: string, to: string): number {
  let n = 0;
  for (let d = addDays(from, 1); d <= to && n < 400; d = addDays(d, 1)) if (tradingDay(d).ok) n++;
  return n;
}

/** Epoch ms of a New York wall-clock time (date + minutes after midnight), DST-aware. */
export function nyEpoch(date: string, minute: number): number {
  const [y, m, d] = date.split("-").map(Number);
  const want = Date.UTC(y, m - 1, d) + minute * 60_000; // the wall time, as if it were UTC
  let t = want + 5 * 3_600_000; // New York is UTC−5 or UTC−4
  for (let i = 0; i < 3; i++) {
    const c = nyClock(t);
    const [cy, cm, cd] = c.date.split("-").map(Number);
    const seen = Date.UTC(cy, cm - 1, cd) + c.minute * 60_000;
    if (seen === want) break;
    t += want - seen;
  }
  return Math.floor(t / 60_000) * 60_000;
}

export interface Bell {
  open: boolean; // the market is open now
  kind: "open" | "close"; // the next bell
  at: number; // epoch ms of the next bell
  date: string; // its New York date
  weekday: string;
  label: string; // New York time, e.g. "9:30 AM"
  early?: string; // early-close reason, when the next close is at 1:00 PM
  reason: string; // why it's closed now ("weekend", "before the open", …) or "regular session"
  calendarKnown: boolean;
}

/** The next opening or closing bell from `nowMs`: today's close while open, else the next open. */
export function nextBell(nowMs: number): Bell {
  const st = marketStatus(nowMs);
  if (st.open) {
    const s = sessionHours(st.date)!;
    return { open: true, kind: "close", at: nyEpoch(st.date, s.close), date: st.date, weekday: st.weekday, label: clockLabel(s.close), early: st.earlyClose, reason: st.reason, calendarKnown: st.calendarKnown };
  }
  const n = st.nextOpen!;
  return { open: false, kind: "open", at: nyEpoch(n.date, OPEN_MIN), date: n.date, weekday: n.weekday, label: n.label, reason: st.reason, calendarKnown: st.calendarKnown };
}

/** "2d 4h 05m", "3h 05m", "42m 08s", "8s". */
export function countdown(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(t / 86_400);
  const h = Math.floor((t % 86_400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const p2 = (v: number) => String(v).padStart(2, "0");
  if (d > 0) return `${d}d ${h}h ${p2(m)}m`;
  if (h > 0) return `${h}h ${p2(m)}m`;
  if (m > 0) return `${m}m ${p2(sec)}s`;
  return `${sec}s`;
}
