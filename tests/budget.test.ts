import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBudget, fitFor, fitLine, limitsFromBudget } from "../lib/budget";
import { noTradeWhy, skipKind, type SessionPick, type SessionScan } from "../lib/session";
import { validateRules } from "../lib/settings";

test("budget: limits scale with the budget", () => {
  assert.deepEqual(limitsFromBudget({ budget: 200, risk_pct: 2, daily_loss_pct: 5, cash_buffer_pct: 20 }), { max_loss_per_trade_usd: 4, max_daily_loss_usd: 10, max_order_usd: 160 });
  assert.deepEqual(limitsFromBudget({ budget: 5000, risk_pct: 2, daily_loss_pct: 5, cash_buffer_pct: 10 }), { max_loss_per_trade_usd: 100, max_daily_loss_usd: 250, max_order_usd: 4500 });
  // defaults when the percentages are missing
  assert.equal(limitsFromBudget({ budget: 1000 }).max_loss_per_trade_usd, 20);
  // tiny budgets never reach zero
  assert.ok(limitsFromBudget({ budget: 1, risk_pct: 0.1 }).max_loss_per_trade_usd >= 0.01);
});

test("budget: applyBudget only acts when the switch is on", () => {
  const r = { budget: 200, risk_pct: 2, daily_loss_pct: 5, cash_buffer_pct: 20, max_loss_per_trade_usd: 50 };
  assert.equal(applyBudget(r).max_loss_per_trade_usd, 50);
  assert.equal(applyBudget({ ...r, auto_from_budget: true }).max_loss_per_trade_usd, 4);
});

test("budget: settings save the worked-out dollars, whatever was typed", () => {
  const v = validateRules({ budget: "200", cash_buffer_pct: "20", auto_from_budget: true, risk_pct: "2", daily_loss_pct: "5", max_loss_per_trade_usd: "50", max_daily_loss_usd: "150", max_order_usd: "500", min_order_usd: "5" });
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.equal(v.values.max_loss_per_trade_usd, 4);
  assert.equal(v.values.max_daily_loss_usd, 10);
  assert.equal(v.values.max_order_usd, 160);
  // off: the typed dollars stay
  const off = validateRules({ budget: "200", auto_from_budget: false, risk_pct: "2", max_loss_per_trade_usd: "50", max_daily_loss_usd: "150" });
  assert.ok(off.ok && off.values.max_loss_per_trade_usd === 50);
  // a bad percentage is an error, not a silent default
  const bad = validateRules({ budget: "200", auto_from_budget: true, risk_pct: "40" });
  assert.ok(!bad.ok && bad.errors.risk_pct);
});

test("budget: $200 with $2 fees can't pay for a day trade; a bigger budget can", () => {
  const small = fitFor({ budget: 200, cash_buffer_pct: 20, max_position_pct: 75, auto_from_budget: true, risk_pct: 2, daily_loss_pct: 5 });
  const orb = small.strategies.find((s) => s.id === "orb")!;
  assert.equal(orb.fee, 2);
  assert.ok(orb.feePct > 50, `fees ${orb.feePct}% of risk`);
  assert.equal(orb.verdict, "no");
  assert.ok(orb.minBudget && orb.minBudget > 200);
  assert.match(fitLine(orb), /Fees eat the trade; fits from about \$/);
  // at the suggested budget it fits
  const big = fitFor({ budget: orb.minBudget, cash_buffer_pct: 20, max_position_pct: 75, auto_from_budget: true, risk_pct: 2, daily_loss_pct: 5 });
  assert.equal(big.strategies.find((s) => s.id === "orb")!.verdict, "fits");
  // a fixed $50 max loss: the cost cap decides instead
  const fixed = fitFor({ budget: 5000, cash_buffer_pct: 10, max_position_pct: 75, max_order_usd: 4000, max_loss_per_trade_usd: 50 });
  assert.equal(fixed.strategies.find((s) => s.id === "orb")!.verdict, "fits");
  assert.equal(fixed.maxFeePct, undefined);
});

test("session: why no trade, in plain words", () => {
  const scan = (at: string, early: Record<string, number>, rejected: Record<string, number>, ready: string[] = []): SessionScan => ({ at, source: "shortlist", universe: 21, early, checked: 5, rejected, ready });
  const scans = [scan("2026-11-23T15:27:00Z", { "already broke out": 11 }, { "below VWAP": 2 }), scan("2026-11-23T16:00:00Z", { "already broke out": 13 }, { "range too narrow": 2, "below VWAP": 1 })];
  const lines = noTradeWhy([], scans, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /2 scans of 21 shortlisted names: none had a range ready/);
  assert.match(lines[0], /By the first scan \(10:27 AM NY\), 11 of 21 had already broken out/);
  assert.match(lines[0], /below VWAP \(2\)/);

  const pick = (why: string, verdict: "take" | "skip" = "skip"): SessionPick => ({ at: "2026-11-23T16:00:00Z", symbol: "X", setup: "orb", verdict, trigger: 1, stop: 0.9, target: 1.2, why });
  const two = noTradeWhy([pick("Chart 2/5: lower highs"), pick("Fees: $2 vs $1 risk")], [], []);
  assert.match(two[0], /planned 2 trades and skipped them all: .*weak chart \(1\)/);
  // a take means there's nothing to explain
  assert.deepEqual(noTradeWhy([pick("good", "take")], scans, []), []);
  assert.deepEqual(noTradeWhy([], [], []), ["No run has scanned the shortlist yet."]);
});

test("session: skip reasons sort into plain kinds", () => {
  assert.equal(skipKind("Fees: $150 position cap gives max loss about $1.00"), "fees too big for the risk");
  assert.equal(skipKind("Chart 3/5 in a DEFENSIVE market (needs 4-5)"), "defensive market");
  assert.equal(skipKind("Chart 2/5: daily downtrend"), "weak chart");
  assert.equal(skipKind("Coin flip: target 0.1% vs stop 0.1%"), "odds not good enough");
  assert.equal(skipKind("Chart 3 with flaws: range high is a single wick"), "chart only average");
});
