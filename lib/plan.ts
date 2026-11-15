import type { Action } from "./types";

// Trade plan for a BUY call: stop, target, position size and a PASS/BLOCK risk check.
// Ported from the day-trader skills' method (trader-exit → trader-budget → trader-risk),
// adapted to Dodona's daily bars: the stop is a multiple of the 14-day ATR, the target a
// multiple of the risk (R). Pure and shared: no I/O, nothing is ever placed.
//
// Long side only. A stop too far away for the max loss is a refusal, not a smaller order.

export interface PlanSettings {
  account: number; // dollars available to this strategy
  maxLossPerTrade: number; // dollars lost if the stop fills at its price
  maxPositionPct: number; // fraction of account in one position, e.g. 0.25
  cashBuffer: number; // dollars always left uninvested
  minRewardRisk: number; // e.g. 2 means the target must be ≥ 2× the risk
  stopAtr: number; // stop = entry − stopAtr × ATR14
  targetR: number; // target = entry + targetR × risk
  minStopPct: number; // stop closer than this fraction of price is too tight for daily noise
  blocked: string[]; // tickers never to plan
}

export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  account: 10_000,
  maxLossPerTrade: 100,
  maxPositionPct: 0.25,
  cashBuffer: 0,
  minRewardRisk: 2,
  stopAtr: 2,
  targetR: 2,
  minStopPct: 0.01,
  blocked: [],
};

export interface PlanCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export type SizedBy = "max loss" | "position cap" | "cash";

export interface TradePlan {
  status: "READY" | "BLOCKED" | "NONE";
  reason: string; // one line: why READY / BLOCKED / no plan
  entry?: number;
  stop?: number;
  target?: number;
  riskPerShare?: number;
  rewardRisk?: number;
  shares?: number;
  cost?: number;
  maxLoss?: number; // at the stop price; a gap can fill worse
  maxGain?: number;
  sizedBy?: SizedBy;
  checks: PlanCheck[];
}

export interface PlanInput {
  symbol: string;
  action: Action;
  price: number;
  atr14?: number;
}

const cents = (v: number) => Math.round(v * 100) / 100;
const floorCents = (v: number) => Math.floor(v * 100 + 1e-9) / 100;
const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function buildTradePlan(input: PlanInput, s: PlanSettings = DEFAULT_PLAN_SETTINGS): TradePlan {
  const symbol = input.symbol.toUpperCase();
  if (input.action !== "BUY") {
    return { status: "NONE", reason: `No plan: the call is ${input.action}. Dodona plans long entries on BUY calls only.`, checks: [] };
  }
  if (!(input.price > 0)) return { status: "NONE", reason: "No plan: no valid price.", checks: [] };
  if (!input.atr14 || !(input.atr14 > 0)) {
    return { status: "NONE", reason: "No plan: not enough history for a 14-day ATR, so there is no stop to size from.", checks: [] };
  }

  const entry = cents(input.price);
  // Stop rounded down to the cent, like trader-exit: never tighter than the rule says.
  const stop = floorCents(input.price - s.stopAtr * input.atr14);
  const risk = cents(entry - stop);
  const target = cents(entry + s.targetR * risk);
  const rewardRisk = risk > 0 ? (target - entry) / risk : 0;

  const checks: PlanCheck[] = [];
  checks.push({
    name: "Ticker allowed",
    pass: !s.blocked.map((b) => b.toUpperCase()).includes(symbol),
    detail: s.blocked.length ? `Blocked list: ${s.blocked.join(", ")}` : "No blocked tickers",
  });
  checks.push({
    name: "Stop below entry",
    pass: stop > 0 && stop < entry,
    detail: `Stop ${usd(stop)} = entry ${usd(entry)} − ${s.stopAtr} × ATR ${input.atr14.toFixed(2)}`,
  });
  const stopPct = risk / entry;
  checks.push({
    name: "Stop not too tight",
    pass: stopPct >= s.minStopPct,
    detail: `${(stopPct * 100).toFixed(1)}% below entry (minimum ${(s.minStopPct * 100).toFixed(1)}%)`,
  });
  checks.push({
    name: "Reward : risk",
    pass: rewardRisk + 1e-9 >= s.minRewardRisk,
    detail: `${rewardRisk.toFixed(2)} : 1 (minimum ${s.minRewardRisk} : 1)`,
  });

  // Sizing (trader-budget): the whole shares that fit every limit; say which one decided it.
  const spendable = Math.max(0, s.account - s.cashBuffer);
  const caps: Array<[SizedBy, number]> = [
    ["max loss", risk > 0 ? Math.floor(s.maxLossPerTrade / risk + 1e-9) : 0],
    ["position cap", Math.floor((s.account * s.maxPositionPct) / entry + 1e-9)],
    ["cash", Math.floor(spendable / entry + 1e-9)],
  ];
  const [sizedBy, shares] = caps.reduce((a, b) => (b[1] < a[1] ? b : a));
  checks.push({
    name: "Loss at stop fits max loss",
    pass: caps[0][1] >= 1,
    detail:
      caps[0][1] >= 1
        ? `${shares} × ${usd(risk)} = ${usd(shares * risk)} ≤ ${usd(s.maxLossPerTrade)}`
        : `1 share already risks ${usd(risk)} > ${usd(s.maxLossPerTrade)}: the stop is too far for your max loss`,
  });
  checks.push({
    name: "Fits position cap and cash",
    pass: caps[1][1] >= 1 && caps[2][1] >= 1,
    detail: `Cap ${usd(s.account * s.maxPositionPct)} (${(s.maxPositionPct * 100).toFixed(0)}% of ${usd(s.account)}), cash after buffer ${usd(spendable)}`,
  });

  const plan: TradePlan = {
    status: "READY",
    reason: "",
    entry,
    stop,
    target,
    riskPerShare: risk,
    rewardRisk: Number(rewardRisk.toFixed(2)),
    shares,
    cost: cents(shares * entry),
    maxLoss: cents(shares * risk),
    maxGain: cents(shares * (target - entry)),
    sizedBy,
    checks,
  };
  const failed = checks.filter((c) => !c.pass);
  if (failed.length || shares < 1) {
    plan.status = "BLOCKED";
    plan.reason = failed.length ? `Blocked. Failed ${failed.length === 1 ? "check" : "checks"}: ${failed.map((c) => c.name).join("; ")}.` : "Blocked: no whole share fits.";
  } else {
    plan.reason = `Buy ${shares} ${symbol} at ~${usd(entry)}, stop ${usd(stop)}, target ${usd(target)}. Sized by ${sizedBy}.`;
  }
  return plan;
}

/** Merges stored (possibly partial or stale) settings over the defaults and drops invalid numbers. */
export function normalizePlanSettings(raw: Partial<PlanSettings> | null | undefined): PlanSettings {
  const out: PlanSettings = { ...DEFAULT_PLAN_SETTINGS, blocked: [...DEFAULT_PLAN_SETTINGS.blocked] };
  if (!raw) return out;
  for (const k of Object.keys(DEFAULT_PLAN_SETTINGS) as Array<keyof PlanSettings>) {
    if (k === "blocked") continue;
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) (out[k] as number) = v;
  }
  if (Array.isArray(raw.blocked)) out.blocked = raw.blocked.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().toUpperCase());
  return out;
}
