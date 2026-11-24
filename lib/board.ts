// Pure and shared: the desk's board, the one place the standing team reads and writes.
//
// The scout (Dodona's watch, code, no tokens) writes every shortlisted stock's state on each look: ready
// (range formed, not broken), broke out, too thin, faded, … The team's decisions are joined in from the
// candidate log. A skip the lead marked as re-checkable (`desk candidate --recheck volume,market`) is
// watched: when the scout sees every one of those reasons clear while the range is still ready, the
// team is woken for that one stock again. Reasons a chart can't change on its own (a wick for a range
// high, a coin-flip Time Machine) are never re-checked: those skips are final for the day.
import type { PendingRange } from "./pending";

/** Skip reasons the scout can check by itself, and what "cleared" means for each. */
export const RECHECKS = {
  volume: "relative volume at or above 1.0 (normal for the time of day)",
  vwap: "price back above VWAP",
  market: "SPY back above its VWAP (the market mode is no longer defensive)",
} as const;
export type Recheck = keyof typeof RECHECKS;
export const isRecheck = (x: string): x is Recheck => x in RECHECKS;

/** At most this many re-checks per stock per day, at least this far apart: each one wakes the team. */
export const MAX_RECHECKS = 2;
export const RECHECK_GAP_MIN = 20;

export type BoardState = "ready" | "broke out" | "not ready" | "out";

export interface Decision {
  at: string; // ISO
  verdict: "take" | "skip";
  why: string;
  chartScore?: number;
  recheck?: Recheck[]; // the skip holds only while these hold
}

export interface BoardRow {
  symbol: string;
  state: BoardState;
  note: string; // the scout's reason, in plain words
  price?: number;
  orHigh?: number;
  orLow?: number;
  vwap?: number;
  relVolume?: number;
  belowHighPct?: number;
  decision?: Decision; // the team's latest call on it today
  rechecks?: number; // how many times the team was woken again for it today
  lastWorked?: string; // ISO: when the team last worked it
  watchingFor?: string; // what the scout is waiting for before it wakes the team again
}

export interface Board {
  date: string;
  at: string; // the scout's last look
  market?: { spy: number; vwap: number; aboveVwap: boolean };
  rows: BoardRow[];
}

type Status = PendingRange | { why: string; price?: number };
const isRange = (s: Status): s is PendingRange => "orHigh" in s;

function stateOf(why: string): BoardState {
  if (/broke out/.test(why)) return "broke out";
  if (/held or blocked|price out of range|downtrend/.test(why)) return "out";
  return "not ready";
}

/** What would clear a skip, judged on this look. Undefined when a reason can't be judged yet. */
export function clearedNow(reasons: Recheck[], row: Pick<BoardRow, "state" | "relVolume" | "price" | "vwap">, market?: Board["market"]): boolean {
  if (row.state !== "ready" || !reasons.length) return false;
  return reasons.every((r) =>
    r === "volume" ? (row.relVolume ?? 0) >= 1 : r === "vwap" ? row.price !== undefined && row.vwap !== undefined && row.price > row.vwap : market?.aboveVwap === true,
  );
}

/**
 * The board after one look: the scan's status per stock, the team's latest decision per stock, and what
 * the scout now waits for. `worked` is the stocks the team was already woken for today (with times).
 */
export function buildBoard(x: {
  date: string;
  at: string;
  status: Record<string, Status>;
  decisions: Record<string, Decision>;
  worked: Record<string, { at: string; rechecks: number }>;
  market?: Board["market"];
}): Board {
  const order: Record<BoardState, number> = { ready: 0, "broke out": 1, "not ready": 2, out: 3 };
  const rows = Object.entries(x.status).map(([symbol, s]): BoardRow => {
    const base: BoardRow = isRange(s)
      ? { symbol, state: "ready", note: `range ${s.orLow}–${s.orHigh}, ${s.belowHighPct}% under the trigger`, price: s.last, orHigh: s.orHigh, orLow: s.orLow, vwap: s.vwap, relVolume: s.relVolume, belowHighPct: s.belowHighPct }
      : { symbol, state: stateOf(s.why), note: s.why, ...(s.price !== undefined ? { price: s.price } : {}) };
    const d = x.decisions[symbol];
    const w = x.worked[symbol];
    const row: BoardRow = { ...base, ...(d ? { decision: d } : {}), ...(w ? { rechecks: w.rechecks, lastWorked: w.at } : {}) };
    if (d?.verdict === "skip" && d.recheck?.length && (w?.rechecks ?? 0) < MAX_RECHECKS && row.state !== "broke out" && row.state !== "out") row.watchingFor = d.recheck.map((r) => RECHECKS[r]).join("; ");
    return row;
  });
  rows.sort((a, b) => order[a.state] - order[b.state] || (b.relVolume ?? 0) - (a.relVolume ?? 0) || a.symbol.localeCompare(b.symbol));
  return { date: x.date, at: x.at, ...(x.market ? { market: x.market } : {}), rows };
}

/**
 * Which stocks wake the team on this look: ready ones it never worked today, and skips whose every
 * re-check reason has cleared (at most MAX_RECHECKS a day, RECHECK_GAP_MIN apart).
 */
export function dueForTeam(board: Board, nowMs: number): { fresh: string[]; recheck: Array<{ symbol: string; reasons: Recheck[] }> } {
  const fresh: string[] = [];
  const recheck: Array<{ symbol: string; reasons: Recheck[] }> = [];
  for (const r of board.rows) {
    if (r.state !== "ready") continue;
    if (!r.lastWorked) {
      fresh.push(r.symbol);
      continue;
    }
    const d = r.decision;
    if (d?.verdict !== "skip" || !d.recheck?.length) continue;
    if ((r.rechecks ?? 0) >= MAX_RECHECKS) continue;
    if (nowMs - Date.parse(r.lastWorked) < RECHECK_GAP_MIN * 60_000) continue;
    if (Date.parse(d.at) < Date.parse(r.lastWorked)) continue; // no decision since the last wake: that run never decided, don't loop
    if (clearedNow(d.recheck, r, board.market)) recheck.push({ symbol: r.symbol, reasons: d.recheck });
  }
  return { fresh, recheck };
}

/** The team's latest decision per stock today, from the candidate log (live runs only). */
export function latestDecisions(cands: Array<{ at: string; date: string; mode: string; symbol: string; verdict: "take" | "skip"; why: string; chartScore?: number; recheck?: string[] }>, date: string): Record<string, Decision> {
  const out: Record<string, Decision> = {};
  for (const c of cands) {
    if (c.date !== date || c.mode !== "live") continue;
    const prev = out[c.symbol];
    if (prev && Date.parse(prev.at) > Date.parse(c.at)) continue;
    const recheck = (c.recheck ?? []).filter(isRecheck);
    out[c.symbol] = { at: c.at, verdict: c.verdict, why: c.why, ...(c.chartScore !== undefined ? { chartScore: c.chartScore } : {}), ...(recheck.length ? { recheck } : {}) };
  }
  return out;
}
