// Pure: one trading session in facts, for the Desk's team-run card. Built from the team's own logs
// (the shortlist, every candidate it looked at, the coach's replays, IBKR's order log), not from the
// lead's prose, so every number on the card comes from a file.
import type { BudgetFit } from "./budget";
import type { Candidate, Replay } from "./learning";

export interface SessionPick {
  at: string; // ISO time of the decision
  symbol: string;
  setup: string;
  verdict: "take" | "skip";
  chartScore?: number;
  marketMode?: string;
  trigger: number;
  stop: number;
  target: number;
  why: string; // the first clause of the team's reason
  outcome?: Replay["outcome"]; // after the coach's review
  R?: number;
  rightCall?: boolean | null;
}

export interface SessionOrder {
  at: string;
  symbol: string;
  side: string;
  qty?: string;
  kind?: string;
  status: string;
  plain?: string;
}

/** One live run's scan of the shortlist (scripts/desk.ts `pending`). */
export interface SessionScan {
  at: string;
  source: string;
  universe: number;
  early?: Record<string, number>;
  checked: number;
  rejected: Record<string, number>;
  ready: string[];
}

export interface SessionSummary {
  date: string;
  scans: SessionScan[]; // every live run's look at the shortlist, oldest first
  shortlist?: { kept: number; dropped: { symbol: string; why: string }[]; universe?: number; spyReturn20?: number };
  picks: SessionPick[];
  orders: SessionOrder[]; // real IBKR orders and stop changes that day, newest last
  review?: { reviewedAt?: string; right: number; graded: number; triggered: number; skipR: number; takeR: number };
  track?: TeamTrack; // every reviewed session so far
  noTrade?: string[]; // when nothing was taken: why, in plain words (scans, the team's skips)
  fit?: BudgetFit; // what the budget can pay for (lib/budget.ts)
}

/** How the team is doing across every session the coach reviewed. */
export interface TeamTrack {
  sessions: number;
  graded: number;
  right: number;
  pct: number; // right calls, 0-100
  grade: "A" | "B" | "C" | "D";
  takes: number;
  takeR: number; // what the trades it took made, in R
  passedUp: number; // skips that would have hit the target
  passedUpR: number;
  avoided: number; // skips that would have hit the stop
  avoidedR: number;
}

/** The team's grade: the share of right calls (A 85%+, B 70%+, C 55%+, else D). It grades decisions, not money. */
export function teamTrack(replays: Replay[]): TeamTrack | undefined {
  const graded = replays.filter((r) => r.rightCall !== null);
  if (!graded.length) return undefined;
  const right = graded.filter((r) => r.rightCall === true).length;
  const pct = Math.round((right / graded.length) * 100);
  const takes = replays.filter((r) => r.verdict === "take");
  const skips = replays.filter((r) => r.verdict === "skip");
  const up = skips.filter((r) => r.outcome === "target");
  const av = skips.filter((r) => r.outcome === "stop");
  return {
    sessions: new Set(replays.map((r) => r.date)).size,
    graded: graded.length,
    right,
    pct,
    grade: pct >= 85 ? "A" : pct >= 70 ? "B" : pct >= 55 ? "C" : "D",
    takes: takes.length,
    takeR: round(takes.reduce((a, r) => a + r.R, 0)),
    passedUp: up.length,
    passedUpR: round(up.reduce((a, r) => a + r.R, 0)),
    avoided: av.length,
    avoidedR: round(av.reduce((a, r) => a + r.R, 0)),
  };
}

interface OrderRec {
  at: string;
  date: string;
  symbol: string;
  side: string;
  qty?: string;
  kind?: string;
  status: string;
  plain?: string;
  fingerprint?: string;
}

/** The first sentence-ish piece of a reason, short enough for a table cell. */
export function shortWhy(why: string, max = 140): string {
  const first = why.split(/(?<=[.;])\s/)[0] ?? why;
  return first.length > max ? first.slice(0, max - 1).trimEnd() + "…" : first;
}

/** The newest New York date with anything to show (candidates, orders or a shortlist). */
export function latestSessionDate(dates: string[]): string | undefined {
  return dates.filter(Boolean).sort().at(-1);
}

export function buildSession(
  date: string,
  input: {
    candidates: Candidate[];
    replays?: Replay[];
    reviewedAt?: string;
    history?: Replay[]; // every reviewed session's replays, for the team's grade
    orders: OrderRec[];
    shortlist?: { date?: string; kept?: unknown[]; dropped?: { symbol: string; why: string }[]; universe?: number; spyReturn20?: number };
    scans?: SessionScan[];
  },
): SessionSummary {
  const day = input.candidates.filter((c) => c.date === date);
  // a symbol looked at twice keeps its last decision
  const last = new Map<string, Candidate>();
  for (const c of [...day].sort((a, b) => a.at.localeCompare(b.at))) last.set(`${c.mode}:${c.symbol}`, c);
  const rep = new Map((input.replays ?? []).filter((r) => r.date === date).map((r) => [`${r.symbol}@${r.at}`, r]));
  const picks: SessionPick[] = [...last.values()].sort((a, b) => a.at.localeCompare(b.at)).map((c) => {
    const r = rep.get(`${c.symbol}@${c.at}`);
    return {
      at: c.at,
      symbol: c.symbol,
      setup: c.setup,
      verdict: c.verdict,
      chartScore: c.chartScore,
      marketMode: c.marketMode,
      trigger: c.trigger,
      stop: c.stop,
      target: c.target,
      why: shortWhy(c.why),
      ...(r ? { outcome: r.outcome, R: r.R, rightCall: r.rightCall } : {}),
    };
  });

  // one row per order: its last status (approved → placed, or failed)
  const byOrder = new Map<string, OrderRec>();
  for (const o of input.orders.filter((o) => o.date === date)) byOrder.set(o.fingerprint ?? `${o.symbol}@${o.at}`, o);
  const orders = [...byOrder.values()]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(({ at, symbol, side, qty, kind, status, plain }) => ({ at, symbol, side, qty, kind, status, plain }));

  const reviewed = picks.filter((p) => p.outcome !== undefined);
  const review = reviewed.length
    ? {
        reviewedAt: input.reviewedAt,
        right: reviewed.filter((p) => p.rightCall === true).length,
        graded: reviewed.filter((p) => p.rightCall !== null).length,
        triggered: reviewed.filter((p) => p.outcome !== "not-triggered" && p.outcome !== "no-data").length,
        skipR: round(reviewed.filter((p) => p.verdict === "skip").reduce((a, p) => a + (p.R ?? 0), 0)),
        takeR: round(reviewed.filter((p) => p.verdict === "take").reduce((a, p) => a + (p.R ?? 0), 0)),
      }
    : undefined;

  const track = input.history ? teamTrack(input.history) : undefined;
  const noTrade = noTradeWhy(picks, input.scans ?? [], orders);
  const sl = input.shortlist?.date === date ? input.shortlist : undefined;
  return {
    date,
    scans: [...(input.scans ?? [])].sort((a, b) => a.at.localeCompare(b.at)),
    ...(sl ? { shortlist: { kept: sl.kept?.length ?? 0, dropped: sl.dropped ?? [], universe: sl.universe, spyReturn20: sl.spyReturn20 } } : {}),
    picks,
    orders,
    ...(review ? { review } : {}),
    ...(track ? { track } : {}),
    ...(noTrade.length ? { noTrade } : {}),
  };
}

/** What a skip was mostly about, from the lead's own reason. */
export function skipKind(why: string): string {
  const w = why.toLowerCase();
  if (/fee|commission/.test(w)) return "fees too big for the risk";
  if (/defensive/.test(w)) return "defensive market";
  if (/chart\s*[12]\b|chart [12]\/5/.test(w)) return "weak chart";
  if (/coin flip|avg r|time machine|history/.test(w)) return "odds not good enough";
  if (/chart\s*3\b|chart 3\/5/.test(w)) return "chart only average";
  if (/news|avoid|earnings/.test(w)) return "news";
  return "other";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const tally = (m: Record<string, number>) =>
  Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k.replace("x% under", "too far under")} (${n})`)
    .join(", ");

/** Why a session had no new trade, in two or three plain lines. Empty when a trade was taken or placed. */
export function noTradeWhy(picks: SessionPick[], scans: SessionScan[], orders: SessionOrder[]): string[] {
  if (picks.some((p) => p.verdict === "take") || orders.some((o) => o.kind !== "stop" && o.status !== "stop-changed" && o.side?.toUpperCase() === "BUY")) return [];
  const out: string[] = [];
  if (scans.length) {
    const sorted = [...scans].sort((a, b) => a.at.localeCompare(b.at));
    const first = sorted[0];
    const at = new Date(first.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
    const broke = first.early?.["already broke out"] ?? 0;
    const ready = new Set(sorted.flatMap((x) => x.ready));
    const rej: Record<string, number> = {};
    for (const x of sorted) for (const [k, n] of Object.entries(x.rejected)) rej[k] = Math.max(rej[k] ?? 0, n);
    out.push(
      `${plural(sorted.length, "scan")} of ${first.universe} shortlisted names: ${ready.size ? `${ready.size} had a range ready (${[...ready].join(", ")})` : "none had a range ready for a buy-stop"}.` +
        (broke ? ` By the first scan (${at} NY), ${broke} of ${first.universe} had already broken out: a buy-stop has to be at IBKR before the breakout.` : "") +
        (Object.keys(rej).length && !ready.size ? ` The others: ${tally(rej)}.` : ""),
    );
  }
  const skips = picks.filter((p) => p.verdict === "skip");
  if (skips.length) {
    const kinds: Record<string, number> = {};
    for (const p of skips) kinds[skipKind(p.why)] = (kinds[skipKind(p.why)] ?? 0) + 1;
    out.push(`The team planned ${plural(skips.length, "trade")} and skipped them all: ${tally(kinds)}.`);
  }
  if (!out.length) out.push("No run has scanned the shortlist yet.");
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;
