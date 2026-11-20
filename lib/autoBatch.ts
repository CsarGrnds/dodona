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

/** The 9:35 AM New York text: where the day stands, 5 minutes into the session. */
export interface OpenNoteInput {
  date: string; // today, New York
  gateway: "ready" | "login" | "down" | string;
  shortlist?: { date?: string; kept?: Array<{ symbol: string }>; dropped?: Array<{ symbol: string }> } | null;
  times: string[]; // the batch times, "HH:MM" New York
  nowMinute: number;
}
const ampm = (t: string) => {
  const h = Number(t.slice(0, 2));
  return `${h % 12 || 12}:${t.slice(3)} ${h < 12 ? "AM" : "PM"}`;
};
export function openNote(x: OpenNoteInput): string {
  const lines: string[] = [];
  if (x.gateway !== "ready") lines.push("IBKR gateway is LOGGED OUT: log in at https://localhost:5001 on your Mac, or no batch can run.");
  const sl = x.shortlist?.date === x.date ? x.shortlist : undefined;
  if (!sl) lines.push("No shortlist for today yet: the 9:15 screen hasn't finished.");
  else {
    const kept = (sl.kept ?? []).map((k) => k.symbol);
    const top = kept.slice(0, 6).join(", ");
    const drop = (sl.dropped ?? []).map((d) => d.symbol);
    lines.push(`Shortlist: ${kept.length} names${top ? ` (${top}${kept.length > 6 ? ", …" : ""})` : ""}${drop.length ? `, ${drop.join(", ")} dropped on news` : ""}.`);
  }
  const next = x.times.find((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) > x.nowMinute);
  lines.push(next ? `First batch check at ${ampm(next)} New York. If a trade passes risk you'll get a text: approve it on your Mac within 15 minutes.` : "No batch times left today.");
  return lines.join(" ");
}

/** The text after each batch check (or the 9:15 screen) finishes: its answer, in plain words, cut short. */
export function runNote(result: string | undefined, error?: string, max = 700): string {
  if (error) return `It failed: ${plain(error).slice(0, 300)}`;
  const body = plain(result ?? "");
  if (!body) return "It finished with no report. Look at the Desk.";
  return body.length > max ? body.slice(0, max - 1).replace(/\s+\S*$/, "") + "…" : body;
}
function plain(md: string): string {
  return md
    .replace(/^\|.*\|$/gm, "") // tables
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\n{2,}/g, "\n")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}
