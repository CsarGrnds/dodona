// The pre-trade checklist on the ticker page: every signal Dodona has for one stock, reduced to
// pass / caution / fail lines a trader runs through before a long entry. Each line says why.
// It is a checklist, not a call: the agent / rule engine makes the call. Pure and shared.

import type { SwingBacktest } from "./backtest";
import { tradingDaysBetween } from "./clock";
import { MIN_TOUCHES, resistanceBefore, supportAbove, type ChartLevels } from "./levels";
import { SWING_VOLUME_X, type MarketContext, type SignalContext } from "./market";
import { MOVE_PCT, RISK_TAGS, tagText, type Filing } from "./news";
import type { TradePlan } from "./plan";
import { SETUP_LABEL, type SwingSetup } from "./setups";
import { lean, leanKind, type TimeMachineResult } from "./timemachine";
import type { Indicators, NewsItem, Quote } from "./types";

export type CheckStatus = "pass" | "warn" | "fail" | "info" | "na";

export interface Check {
  key: string;
  group: "Chart" | "Setup" | "Plan" | "Events";
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface ChecklistInput {
  today: string; // New York date
  quote: Quote;
  indicators: Indicators;
  market?: MarketContext;
  relativeStrength?: number;
  levels?: ChartLevels;
  swing?: { tags: SwingSetup[]; context: SignalContext; backtest: SwingBacktest } | null;
  plan?: TradePlan; // the long plan at today's price (hypothetical when the call isn't BUY)
  timeMachine?: TimeMachineResult | null;
  nextEarningsDate?: string;
  earningsEstimated?: boolean;
  holdDays: number; // the plan's time limit in sessions
  news: NewsItem[];
  filings?: Filing[] | null; // null = SEC not configured
}

const money = (v: number) => `$${v.toFixed(2)}`;
const pct = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
const daysAgo = (today: string, iso: string) => Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(iso)) / 86_400_000);

export function buildChecklist(x: ChecklistInput): Check[] {
  const out: Check[] = [];
  const price = x.quote.price;
  const { sma50, sma200 } = x.indicators;

  // ---------------------------------------------------------------- chart
  if (sma50 !== undefined) {
    const a50 = price > sma50;
    const a200 = sma200 === undefined ? undefined : price > sma200;
    out.push({
      key: "trend",
      group: "Chart",
      label: "Trend",
      status: a50 && a200 !== false ? "pass" : !a50 && a200 === false ? "fail" : "warn",
      detail: `${money(price)} vs 50-day ${money(sma50)}${sma200 !== undefined ? ` and 200-day ${money(sma200)}` : ""}: ${a50 && a200 !== false ? "above both" : !a50 && a200 === false ? "below both" : a50 ? "above the 50-day, below the 200-day" : "below the 50-day, above the 200-day"}`,
    });
  }
  if (x.market) {
    const m = x.market;
    out.push({ key: "market", group: "Chart", label: "Market (SPY)", status: m.trend === "up" ? "pass" : m.trend === "down" ? "fail" : "warn", detail: `${m.trend === "up" ? "Uptrend" : m.trend === "down" ? "Downtrend" : "Mixed"}: ${m.detail}` });
  }
  if (x.relativeStrength !== undefined) {
    const rs = x.relativeStrength;
    out.push({ key: "rs", group: "Chart", label: "Stronger than the market", status: rs > 0 ? "pass" : "fail", detail: `3-month return ${pct(rs)} vs SPY` });
  }
  if (x.levels) {
    const r = x.levels.resistances[0];
    const s = x.levels.supports[0];
    out.push({
      key: "levels",
      group: "Chart",
      label: "Nearest levels",
      status: "info",
      detail: `${s ? `support ${money(s.price)} (${pct(s.distancePct)}, ${s.touches}×)` : "no support below in the last year"} · ${r ? `resistance ${money(r.price)} (${pct(r.distancePct)}, ${r.touches}×)` : "no resistance above: at a 1-year high"}`,
    });
  }

  // ---------------------------------------------------------------- setup
  if (x.swing) {
    const { tags, context, backtest } = x.swing;
    if (!tags.length) out.push({ key: "setup", group: "Setup", label: "Swing setup today", status: "info", detail: "None of the five scanner setups on the last close: no chart trigger to enter on" });
    else {
      out.push({ key: "setup", group: "Setup", label: "Swing setup today", status: "pass", detail: tags.map((t) => SETUP_LABEL[t]).join(", ") });
      const recs = tags.map((t) => ({ t, r: backtest.bySetup[t] })).filter((v) => v.r.trades > 0).sort((a, b) => b.r.avgR - a.r.avgR);
      const best = recs[0];
      const base = backtest.baseline.avgR;
      if (!best) out.push({ key: "record", group: "Setup", label: "Track record here", status: "na", detail: "This setup never fired on this stock in the history" });
      else
        out.push({
          key: "record",
          group: "Setup",
          label: "Track record here",
          status: best.r.sample === "thin" ? "warn" : best.r.avgR > base && best.r.avgR > 0 ? "pass" : "fail",
          detail: `${SETUP_LABEL[best.t]}: ${best.r.avgR >= 0 ? "+" : ""}${best.r.avgR.toFixed(2)}R avg over ${best.r.trades} trades vs ${base >= 0 ? "+" : ""}${base.toFixed(2)}R entering any day${best.r.sample === "thin" ? " (too few trades to trust)" : ""}`,
        });
      if (context.volX !== undefined)
        out.push({ key: "volume", group: "Setup", label: "Volume confirms", status: context.volX >= SWING_VOLUME_X ? "pass" : "warn", detail: `${context.volX.toFixed(1)}× the 20-day average (confirmed at ≥${SWING_VOLUME_X}×)` });
    }
  }

  // ---------------------------------------------------------------- plan
  const p = x.plan;
  if (p && p.entry !== undefined && p.stop !== undefined && p.target !== undefined) {
    if (x.levels) {
      const block = resistanceBefore(x.levels, p.entry, p.target);
      out.push({
        key: "room",
        group: "Plan",
        label: "Room to the target",
        status: block ? "warn" : "pass",
        detail: block ? `Resistance at ${money(block.price)} (${block.touches}×) sits before the ${money(p.target)} target` : `No resistance (${MIN_TOUCHES}+ touches) between ${money(p.entry)} and the ${money(p.target)} target`,
      });
      const floor = supportAbove(x.levels, p.stop, p.entry);
      out.push({
        key: "floor",
        group: "Plan",
        label: "Stop below support",
        status: floor ? "pass" : "warn",
        detail: floor ? `Support at ${money(floor.price)} (${floor.touches}×) stands between the entry and the ${money(p.stop)} stop` : `No support (${MIN_TOUCHES}+ touches) between the entry and the ${money(p.stop)} stop`,
      });
    }
    if (x.timeMachine) {
      const k = leanKind(x.timeMachine);
      const l = lean(x.timeMachine);
      const t = x.timeMachine;
      out.push({
        key: "tm",
        group: "Plan",
        label: "Time Machine",
        status: k === "target" || k === "strong-target" ? "pass" : k === "stop" || k === "strong-stop" ? "fail" : "warn",
        detail: `${(100 * t.pTarget).toFixed(0)}% target first vs ${(100 * t.pStop).toFixed(0)}% stop first${l ? `: at ${+t.rAtTarget.toFixed(2)}R the target needs ${(100 * l.even).toFixed(0)}% of the replays that hit a side, it got ${(100 * l.share).toFixed(0)}%` : ""} · avg ${t.avgR >= 0 ? "+" : ""}${t.avgR.toFixed(2)}R`,
      });
    }
  }
  if (p && p.status !== "NONE") {
    const failed = p.checks.filter((c) => !c.pass);
    out.push({ key: "risk", group: "Plan", label: "Risk check", status: p.status === "READY" ? "pass" : "fail", detail: p.status === "READY" ? `PASS: ${p.shares} shares, ${money(p.maxLoss ?? 0)} at risk, sized by ${p.sizedBy}` : `BLOCK: ${failed.map((c) => c.detail).join("; ") || p.reason}` });
  }

  // ---------------------------------------------------------------- events
  if (x.nextEarningsDate) {
    const n = x.nextEarningsDate >= x.today ? tradingDaysBetween(x.today, x.nextEarningsDate) : -1;
    if (n >= 0)
      out.push({
        key: "earnings",
        group: "Events",
        label: "Earnings date",
        status: n <= x.holdDays ? "warn" : "pass",
        detail: `${x.nextEarningsDate}${x.earningsEstimated ? " (estimated)" : ""}, ${n === 0 ? "today" : `in ${n} session${n === 1 ? "" : "s"}`}${n <= x.holdDays ? `: inside the ${x.holdDays}-session hold, a gap can skip the stop` : ""}`,
      });
  } else out.push({ key: "earnings", group: "Events", label: "Earnings date", status: "na", detail: "No upcoming date from Yahoo" });

  if (Math.abs(x.quote.changePct) >= MOVE_PCT)
    out.push({ key: "move", group: "Events", label: "Big move today", status: "warn", detail: `${pct(x.quote.changePct, 2)} from yesterday's close: check the news before chasing it` });

  const recentRisky = x.news.filter((n) => n.publishedAt && daysAgo(x.today, n.publishedAt) <= 7 && tagText(n.title).some((t) => RISK_TAGS.has(t)));
  out.push({
    key: "headlines",
    group: "Events",
    label: "Headline risk",
    status: recentRisky.length ? "warn" : "pass",
    detail: recentRisky.length ? `${recentRisky.length} headline${recentRisky.length > 1 ? "s" : ""} this week tagged ${[...new Set(recentRisky.flatMap((n) => tagText(n.title).filter((t) => RISK_TAGS.has(t))))].join(", ")}: “${recentRisky[0].title}”` : "No legal, risk or halt headlines this week",
  });

  if (x.filings === null) out.push({ key: "sec", group: "Events", label: "SEC filings", status: "na", detail: "Set SEC_USER_AGENT to read 8-Ks from EDGAR" });
  else if (x.filings) {
    const imp = x.filings.filter((f) => f.important && daysAgo(x.today, f.filed) <= 14);
    out.push({
      key: "sec",
      group: "Events",
      label: "SEC filings",
      status: imp.length ? "warn" : "pass",
      detail: imp.length ? `${imp[0].form} on ${imp[0].filed}: ${imp[0].labels.join(", ")}${imp.length > 1 ? ` (+${imp.length - 1} more)` : ""}` : "No important 8-K in the last two weeks",
    });
  }
  return out;
}

export function tally(checks: Check[]) {
  return {
    pass: checks.filter((c) => c.status === "pass").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length,
  };
}
