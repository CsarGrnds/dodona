import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTradePlan, DEFAULT_PLAN_SETTINGS, normalizePlanSettings, type PlanSettings } from "../lib/plan";

const S = (o: Partial<PlanSettings> = {}): PlanSettings => ({ ...DEFAULT_PLAN_SETTINGS, ...o });

test("BUY: 2×ATR stop, 2R target, sized by max loss", () => {
  // entry 100, ATR 2.5 → stop 95, risk 5, target 110; $100 max loss → 20 shares
  const p = buildTradePlan({ symbol: "abc", action: "BUY", price: 100, atr14: 2.5 }, S());
  assert.equal(p.status, "READY");
  assert.equal(p.stop, 95);
  assert.equal(p.target, 110);
  assert.equal(p.riskPerShare, 5);
  assert.equal(p.rewardRisk, 2);
  assert.equal(p.shares, 20);
  assert.equal(p.sizedBy, "max loss");
  assert.equal(p.cost, 2000);
  assert.equal(p.maxLoss, 100);
  assert.equal(p.maxGain, 200);
  assert.ok(p.checks.every((c) => c.pass));
});

test("stop rounds down to the cent", () => {
  const p = buildTradePlan({ symbol: "X", action: "BUY", price: 50, atr14: 1.2345 }, S());
  assert.equal(p.stop, 47.53); // 50 − 2.469 = 47.531 → 47.53
});

test("position cap decides when the stop is tight", () => {
  // risk 2/share → max loss allows 50; cap 25% of 10k at $100 = 25 shares
  const p = buildTradePlan({ symbol: "X", action: "BUY", price: 100, atr14: 1 }, S());
  assert.equal(p.shares, 25);
  assert.equal(p.sizedBy, "position cap");
  assert.equal(p.status, "READY");
});

test("cash after buffer decides when it is smallest", () => {
  const p = buildTradePlan({ symbol: "X", action: "BUY", price: 100, atr14: 1 }, S({ cashBuffer: 9_000 }));
  assert.equal(p.shares, 10);
  assert.equal(p.sizedBy, "cash");
});

test("stop too far for max loss is a refusal, not a smaller order", () => {
  // risk 200/share > $100 max loss
  const p = buildTradePlan({ symbol: "X", action: "BUY", price: 1000, atr14: 100 }, S());
  assert.equal(p.status, "BLOCKED");
  assert.equal(p.shares, 0);
  const c = p.checks.find((x) => x.name === "Loss at stop fits max loss")!;
  assert.equal(c.pass, false);
  assert.match(c.detail, /too far/);
});

test("reward:risk below the minimum blocks", () => {
  const p = buildTradePlan({ symbol: "X", action: "BUY", price: 100, atr14: 2.5 }, S({ targetR: 1.5 }));
  assert.equal(p.status, "BLOCKED");
  assert.match(p.reason, /Reward : risk/);
});

test("too-tight stop and blocked ticker block", () => {
  const tight = buildTradePlan({ symbol: "X", action: "BUY", price: 100, atr14: 0.2 }, S());
  assert.equal(tight.status, "BLOCKED");
  assert.equal(tight.checks.find((c) => c.name === "Stop not too tight")!.pass, false);

  const blocked = buildTradePlan({ symbol: "gme", action: "BUY", price: 100, atr14: 2.5 }, S({ blocked: ["GME"] }));
  assert.equal(blocked.status, "BLOCKED");
});

test("no plan for HOLD / SELL or missing ATR", () => {
  assert.equal(buildTradePlan({ symbol: "X", action: "HOLD", price: 100, atr14: 2 }).status, "NONE");
  assert.equal(buildTradePlan({ symbol: "X", action: "SELL", price: 100, atr14: 2 }).status, "NONE");
  assert.equal(buildTradePlan({ symbol: "X", action: "BUY", price: 100 }).status, "NONE");
});

test("normalizePlanSettings drops bad values and keeps defaults", () => {
  const s = normalizePlanSettings({ account: -5, maxLossPerTrade: 250, stopAtr: Number.NaN, blocked: [" gme ", "", 3 as unknown as string] });
  assert.equal(s.account, DEFAULT_PLAN_SETTINGS.account);
  assert.equal(s.maxLossPerTrade, 250);
  assert.equal(s.stopAtr, DEFAULT_PLAN_SETTINGS.stopAtr);
  assert.deepEqual(s.blocked, ["GME"]);
  assert.deepEqual(normalizePlanSettings(null), DEFAULT_PLAN_SETTINGS);
});
