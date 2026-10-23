import assert from "node:assert/strict";
import { test } from "node:test";
import { extractJson } from "../lib/agent";
import { computeIndicators, ema, rsi, sma } from "../lib/indicators";
import { dividendSignal, swingSignal } from "../lib/signals";
import type { Bar } from "../lib/types";

function makeBars(closes: number[]): Bar[] {
  const start = Date.UTC(2025, 0, 1);
  return closes.map((c, i) => ({
    time: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    open: c,
    high: c * 1.01,
    low: c * 0.99,
    close: c,
    volume: 1_000_000,
  }));
}

test("sma / ema basics", () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2).slice(1), [1.5, 2.5, 3.5]);
  const e = ema([1, 2, 3, 4, 5], 3);
  assert.equal(e[2], 2);
  assert.ok(Math.abs(e[4] - 4) < 1e-9);
});

test("rsi is 100 on a straight rally and ~0 on a straight decline", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.equal(rsi(up).at(-1), 100);
  assert.ok(rsi(down).at(-1)! < 1);
});

test("swing: steady uptrend scores bullish, crash scores bearish", () => {
  const upCloses = Array.from({ length: 260 }, (_, i) => 100 * Math.pow(1.002, i) + 3 * Math.sin(i * 1.7) + 2 * Math.sin(i / 5));
  const upInd = computeIndicators(makeBars(upCloses));
  const up = swingSignal(upCloses.at(-1)!, upInd);
  assert.ok(up.score > 0, `expected positive, got ${up.score}`);

  const downCloses = Array.from({ length: 260 }, (_, i) => 200 * Math.pow(0.997, i) + 3 * Math.sin(i * 1.7) + 2 * Math.sin(i / 5));
  const downInd = computeIndicators(makeBars(downCloses));
  const down = swingSignal(downCloses.at(-1)!, downInd);
  assert.ok(down.score < 0, `expected negative, got ${down.score}`);
  assert.ok(up.levels.stopLoss! < upCloses.at(-1)!);
});

test("dividend: high yield vs history + safe payout => BUY with levels", () => {
  const closes = Array.from({ length: 260 }, (_, i) => 60 - i * 0.05);
  const ind = computeIndicators(makeBars(closes));
  const sig = dividendSignal(closes.at(-1)!, ind, {
    dividendYield: 0.045,
    fiveYearAvgDividendYield: 0.033,
    dividendRate: 2.1,
    payoutRatio: 0.5,
    forwardPE: 12,
    earningsGrowth: 0.1,
    revenueGrowth: 0.05,
    debtToEquity: 0.4,
    targetMeanPrice: 60,
  });
  assert.equal(sig.action, "BUY");
  assert.ok(sig.levels.buyBelow && sig.levels.trimAbove && sig.levels.buyBelow < sig.levels.trimAbove);
});

test("dividend: stretched valuation + unsafe payout => SELL", () => {
  const closes = Array.from({ length: 260 }, (_, i) => 50 * Math.pow(1.004, i));
  const ind = computeIndicators(makeBars(closes));
  const sig = dividendSignal(closes.at(-1)!, ind, {
    dividendYield: 0.015,
    fiveYearAvgDividendYield: 0.03,
    payoutRatio: 1.1,
    forwardPE: 40,
    earningsGrowth: -0.2,
    debtToEquity: 3,
    targetMeanPrice: closes.at(-1)! * 0.85,
  });
  assert.equal(sig.action, "SELL");
});

test("extractJson handles fenced and bare output", () => {
  assert.equal(extractJson('```json\n{"action":"BUY"}\n```').action, "BUY");
  assert.equal(extractJson('Sure: {"action":"HOLD","risks":[]}').action, "HOLD");
});
