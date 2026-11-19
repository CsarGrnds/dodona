// Pure: the Desk's "Today's analysis" board. Each candidate the trade team looked at (trader/learning/
// candidates.jsonl) is matched with the chart the chartist drew for it (trader/charts/SYM-DATE-HHMM.png,
// New York time), the market chart (SPY) of the same run, the coach's replay after the close, and the
// IBKR ticket it became, if any. Candidates logged close together are one run of the team.
import type { Candidate, Outcome } from "./learning";
import { nyClock } from "./setups";

export const CHART_FILE = /^([A-Z][A-Z0-9.-]{0,9})-(\d{4}-\d{2}-\d{2})-(\d{4})\.png$/;
export const RUN_GAP_MIN = 20; // candidates more than 20 minutes apart belong to different runs

export interface ChartRef {
  file: string;
  symbol: string;
  date: string;
  minute: number; // New York minute of the day it was drawn
}

export interface Ticket {
  status: "staged" | "approved" | "placed" | "failed" | "declined" | "canceled" | "filled";
  qty?: number;
  trigger?: number;
  cost?: number;
  maxLoss?: number;
  at?: string;
  fill?: number;
}

export interface CandidateCard extends Candidate {
  minute: number; // New York minute of the decision
  chart?: string; // chart file name
  review?: { outcome: Outcome; R: number; triggeredAt?: string; exitAt?: string; rightCall: boolean | null };
  ticket?: Ticket;
}

export interface AnalysisRun {
  minute: number; // first decision of the run, New York
  marketMode?: string;
  marketChart?: string;
  mode: "live" | "paper";
  cards: CandidateCard[];
}

export interface Analysis {
  date: string;
  dates: string[]; // days with candidates, newest first
  runs: AnalysisRun[]; // newest first
  totals: { looked: number; taken: number; tickets: number; reviewed: number; rightCalls: number; avgR?: number };
}

export function parseChart(file: string): ChartRef | undefined {
  const m = CHART_FILE.exec(file);
  if (!m) return undefined;
  return { file, symbol: m[1], date: m[2], minute: Number(m[3].slice(0, 2)) * 60 + Number(m[3].slice(2)) };
}

/** The chart drawn for this symbol that day closest before the decision (a minute of slack), else the nearest. */
export function chartFor(symbol: string, date: string, minute: number, charts: ChartRef[]): string | undefined {
  const same = charts.filter((c) => c.symbol === symbol && c.date === date);
  if (!same.length) return undefined;
  const before = same.filter((c) => c.minute <= minute + 1).sort((a, b) => b.minute - a.minute);
  if (before.length) return before[0].file;
  return same.sort((a, b) => Math.abs(a.minute - minute) - Math.abs(b.minute - minute))[0].file;
}

export function buildAnalysis(opts: {
  candidates: Candidate[];
  charts: ChartRef[];
  replays?: Array<Candidate & { outcome: Outcome; R: number; triggeredAt?: string; exitAt?: string; rightCall: boolean | null }>;
  tickets?: Record<string, Ticket>; // by symbol, for this date
  date?: string;
}): Analysis {
  const dates = [...new Set(opts.candidates.map((c) => c.date))].sort().reverse();
  const date = opts.date && dates.includes(opts.date) ? opts.date : dates[0] ?? "";
  const replayKey = (c: Candidate) => `${c.at}|${c.symbol}`;
  const replays = new Map((opts.replays ?? []).map((r) => [replayKey(r), r]));
  const day = opts.candidates.filter((c) => c.date === date).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const cards: CandidateCard[] = day.map((c) => {
    const minute = nyClock(Date.parse(c.at)).minute;
    const r = replays.get(replayKey(c));
    return {
      ...c,
      minute,
      chart: chartFor(c.symbol, c.date, minute, opts.charts),
      ...(r ? { review: { outcome: r.outcome, R: r.R, triggeredAt: r.triggeredAt, exitAt: r.exitAt, rightCall: r.rightCall } } : {}),
    };
  });
  // a ticket belongs to the symbol's last look of the day
  for (const [sym, t] of Object.entries(opts.tickets ?? {})) {
    const last = [...cards].reverse().find((c) => c.symbol === sym);
    if (last) last.ticket = t;
  }

  const runs: AnalysisRun[] = [];
  for (const c of cards) {
    const cur = runs[runs.length - 1];
    const prev = cur?.cards[cur.cards.length - 1];
    if (cur && prev && c.minute - prev.minute <= RUN_GAP_MIN && c.mode === cur.mode) cur.cards.push(c);
    else runs.push({ minute: c.minute, mode: c.mode, cards: [c] });
  }
  for (const r of runs) {
    r.marketMode = r.cards.find((c) => c.marketMode)?.marketMode;
    const last = r.cards[r.cards.length - 1].minute;
    r.marketChart = chartFor("SPY", date, last, opts.charts.filter((c) => c.minute <= last + 1));
    // newest first inside a run too, so the latest look is on top
    r.cards.reverse();
  }

  const reviewed = cards.filter((c) => c.review && c.review.outcome !== "no-data");
  const triggered = reviewed.filter((c) => c.review!.outcome !== "not-triggered");
  return {
    date,
    dates,
    runs: runs.reverse(),
    totals: {
      looked: cards.length,
      taken: cards.filter((c) => c.verdict === "take").length,
      tickets: cards.filter((c) => c.ticket).length,
      reviewed: reviewed.length,
      rightCalls: reviewed.filter((c) => c.review!.rightCall === true).length,
      ...(triggered.length ? { avgR: Math.round((triggered.reduce((a, c) => a + c.review!.R, 0) / triggered.length) * 100) / 100 } : {}),
    },
  };
}
