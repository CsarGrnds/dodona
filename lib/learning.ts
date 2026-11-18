// Pure: how the trade team learns. Every candidate it looks at (taken or skipped) is logged with its
// plan; after the close, each one is replayed on that day's real 5-minute bars to see what it would
// have done: never triggered, hit the target, hit the stop, or sold at the close. The review grades
// the team's calls and adds up what works, which the coach turns into the playbook.
import type { IntradayBar } from "./setups";
import { nyClock } from "./setups";

export interface Candidate {
  at: string; // ISO time of the decision
  date: string; // New York date
  mode: "live" | "paper";
  symbol: string;
  setup: string;
  trigger: number;
  stop: number;
  target: number;
  verdict: "take" | "skip";
  why: string;
  chartScore?: number; // the chartist's 1-5
  marketMode?: string; // "aggressive" | "normal" | "defensive"
}

export type Outcome = "target" | "stop" | "close" | "not-triggered" | "no-data";

export interface Replay extends Candidate {
  outcome: Outcome;
  R: number; // 0 when never triggered
  triggeredAt?: string; // New York HH:MM
  exitAt?: string;
  rightCall: boolean | null; // take that made money, or skip that would have lost or never triggered; null: a take that never triggered (no money either way)
}

const hhmm = (t: number) => {
  const m = nyClock(t).minute;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/**
 * Replay a buy-stop bracket on one session's 5-minute bars, from the decision on: it triggers on the
 * first bar trading at or above the trigger; then the stop or the target, whichever is touched first
 * (both in one bar counts as the stop: the cautious reading); else it is sold at the session's last
 * close. A bar that opens above the trigger fills at its open (a gap), and a gap through the stop
 * fills at the open too.
 */
export function replay(c: Candidate, bars: IntradayBar[], flatByMinute = 955): Replay {
  const after = Date.parse(c.at);
  const day = bars.filter((b) => {
    const k = nyClock(b.t);
    return k.date === c.date && k.minute >= 570 && k.minute < 960 && b.t + 5 * 60_000 > after;
  });
  const risk = c.trigger - c.stop;
  const done = (outcome: Outcome, exit: number, ti?: number, xi?: number): Replay => {
    const R = outcome === "not-triggered" || outcome === "no-data" ? 0 : Math.round(((exit - Math.max(c.trigger, ti !== undefined ? Math.max(day[ti].open, c.trigger) : c.trigger)) / risk) * 100) / 100;
    const rightCall = c.verdict === "take" ? (outcome === "not-triggered" || outcome === "no-data" ? null : R > 0) : outcome === "no-data" ? null : outcome === "not-triggered" || R <= 0;
    return { ...c, outcome, R, triggeredAt: ti !== undefined ? hhmm(day[ti].t) : undefined, exitAt: xi !== undefined ? hhmm(day[xi].t) : undefined, rightCall };
  };
  if (!day.length || !(risk > 0)) return done("no-data", 0);
  const ti = day.findIndex((b) => b.high >= c.trigger);
  if (ti < 0) return done("not-triggered", 0);
  const entry = Math.max(day[ti].open, c.trigger);
  for (let i = ti; i < day.length; i++) {
    const b = day[i];
    if (nyClock(b.t).minute >= flatByMinute) return done("close", b.open, ti, i);
    const lowSeen = i === ti ? Math.min(b.low, entry) : b.low;
    if (lowSeen <= c.stop) return done("stop", i > ti && b.open < c.stop ? b.open : c.stop, ti, i);
    if (b.high >= c.target && (i > ti || b.close >= c.target || entry < c.target)) return done("target", i > ti && b.open > c.target ? b.open : c.target, ti, i);
  }
  return done("close", day[day.length - 1].close, ti, day.length - 1);
}

export interface Bucket {
  n: number;
  triggered: number;
  avgR: number; // over triggered ones
  winRate: number; // of triggered
  rightCalls: number;
}

function bucket(rs: Replay[]): Bucket {
  const t = rs.filter((r) => r.outcome !== "not-triggered" && r.outcome !== "no-data");
  const sum = t.reduce((a, r) => a + r.R, 0);
  return { n: rs.length, triggered: t.length, avgR: t.length ? Math.round((sum / t.length) * 100) / 100 : 0, winRate: t.length ? Math.round((t.filter((r) => r.R > 0).length / t.length) * 100) / 100 : 0, rightCalls: rs.filter((r) => r.rightCall === true).length };
}

/** What works, across every review so far: by verdict, setup, chart score and market mode. */
export function learningStats(rs: Replay[]) {
  const by = (key: (r: Replay) => string | undefined) => {
    const m = new Map<string, Replay[]>();
    for (const r of rs) {
      const k = key(r);
      if (k === undefined) continue;
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return Object.fromEntries([...m.entries()].map(([k, v]) => [k, bucket(v)]));
  };
  return {
    all: bucket(rs),
    byVerdict: by((r) => r.verdict),
    bySetup: by((r) => r.setup),
    byChartScore: by((r) => (r.chartScore === undefined ? undefined : r.chartScore >= 4 ? "4-5" : r.chartScore >= 3 ? "3" : "1-2")),
    byMarketMode: by((r) => r.marketMode),
    sampleNote: rs.length < 30 ? `Only ${rs.length} candidates so far: treat any pattern as a hint, not a rule, until a bucket has 20+.` : undefined,
  };
}
