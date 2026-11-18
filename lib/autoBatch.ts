// Pure: when Dodona starts the team's live batch run by itself ("Prepare the IBKR batch by itself" in
// Settings). The user lists New York times (e.g. "09:47, 11:00, 13:00"); a time is due from that
// minute for 10 minutes (a busy minute or a short sleep doesn't skip it), once a day. The run only
// prepares the batch; the user still approves it.

import { tradingDay } from "./clock";
import { nyClock } from "./setups";

export const DEFAULT_AUTO_TIMES = "09:47, 11:00, 13:00";
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "9:47, 11:00,13:00" → ["09:47", "11:00", "13:00"]; anything else (or outside 9:46-15:00) is dropped. */
export function parseAutoTimes(s: string): string[] {
  return [...new Set(String(s ?? "").split(/[\s,;]+/).map((t) => t.trim()).filter((t) => TIME.test(t)).map((t) => t.padStart(5, "0")))]
    .filter((t) => {
      const m = Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
      return m >= 9 * 60 + 46 && m <= 15 * 60;
    })
    .sort();
}

/** The slot due now (or undefined): reached in the last 10 minutes and not done yet today. */
export function dueSlot(times: string[], nowMinute: number, done: string[]): string | undefined {
  return times.find((t) => {
    const m = Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    return nowMinute >= m && nowMinute < m + 10 && !done.includes(t);
  });
}

/**
 * The next scheduled team run: today's next time if the market trades today, else the first time on
 * the next trading day (NYSE holidays skipped). `at` is epoch ms (exact except across a DST change).
 */
export function nextAutoRun(nowMs: number, times: string[]): { at: number; time: string; dayLabel: string } | undefined {
  if (!times.length) return undefined;
  const { date, minute } = nyClock(nowMs);
  const mins = times.map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)));
  for (let d = 0; d < 10; d++) {
    const day = addDays(date, d);
    if (!tradingDay(day).ok) continue;
    const i = mins.findIndex((m) => d > 0 || m > minute);
    if (i < 0) continue;
    const at = nowMs + d * 86_400_000 + (mins[i] - minute) * 60_000 - (nowMs % 60_000);
    const dayLabel = d === 0 ? "today" : d === 1 ? "tomorrow" : new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    return { at, time: times[i], dayLabel };
  }
  return undefined;
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
