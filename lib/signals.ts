import type { Action, Factor, Fundamentals, Indicators, RuleSignal, Strategy } from "./types";

// Deterministic, explainable scoring. Every factor contributes -2..+2 and says why.
// The agent (Claude) sees these factors and can agree or override with reasoning.

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const BUY_AT = 25;
const SELL_AT = -25;

function finalize(strategy: Strategy, factors: Factor[], levels: RuleSignal["levels"]): RuleSignal {
  const raw = factors.reduce((s, f) => s + f.score, 0);
  const maxAbs = Math.max(1, factors.length * 2);
  const score = Math.round((raw / maxAbs) * 100);
  const action: Action = score >= BUY_AT ? "BUY" : score <= SELL_AT ? "SELL" : "HOLD";
  const dir = Math.sign(score);
  const agreeing = factors.filter((f) => Math.sign(f.score) === dir && f.score !== 0).length;
  const active = factors.filter((f) => f.score !== 0).length || 1;
  const confidence = Math.min(1, 0.6 * Math.min(1, Math.abs(score) / 60) + 0.4 * (agreeing / active));
  return { strategy, action, score, confidence: Number(confidence.toFixed(2)), factors, levels };
}

export function dividendSignal(price: number, ind: Indicators, f: Fundamentals): RuleSignal {
  const factors: Factor[] = [];

  // 1. Yield vs its own 5-year average: the classic "yield theory" valuation.
  if (f.dividendYield !== undefined && f.fiveYearAvgDividendYield) {
    const ratio = f.dividendYield / f.fiveYearAvgDividendYield;
    const score = ratio >= 1.15 ? 2 : ratio >= 1.05 ? 1 : ratio <= 0.75 ? -2 : ratio <= 0.88 ? -1 : 0;
    factors.push({
      name: "Yield vs 5y average",
      score,
      detail: `Yield ${pct(f.dividendYield)} vs 5y avg ${pct(f.fiveYearAvgDividendYield)} (${ratio.toFixed(2)}x)`,
    });
  } else if (!f.dividendYield) {
    factors.push({ name: "Dividend", score: -1, detail: "No dividend — weak fit for a dividend-growth strategy" });
  }

  // 2. Dividend safety.
  if (f.payoutRatio !== undefined && f.payoutRatio > 0) {
    const p = f.payoutRatio;
    const score = p < 0.6 ? 1 : p > 0.95 ? -2 : p > 0.8 ? -1 : 0;
    factors.push({ name: "Payout ratio", score, detail: `${pct(p)} of earnings paid out${p > 0.8 ? " (normal for REITs/MLPs, a risk for most others)" : ""}` });
  }

  // 3. Valuation.
  const pe = f.forwardPE ?? f.trailingPE;
  if (pe !== undefined && pe > 0) {
    const score = pe < 13 ? 1 : pe > 35 ? -2 : pe > 25 ? -1 : 0;
    factors.push({ name: "P/E", score, detail: `${f.forwardPE ? "Forward" : "Trailing"} P/E ${pe.toFixed(1)}` });
  }

  // 4. Growth backing the dividend.
  if (f.earningsGrowth !== undefined || f.revenueGrowth !== undefined) {
    const eg = f.earningsGrowth ?? 0;
    const rg = f.revenueGrowth ?? 0;
    const score = eg > 0.08 && rg > 0.03 ? 1 : eg < -0.15 || rg < -0.05 ? -1 : 0;
    factors.push({ name: "Growth", score, detail: `Earnings ${pct(eg)}, revenue ${pct(rg)} YoY` });
  }

  // 5. Balance sheet.
  if (f.debtToEquity !== undefined) {
    const score = f.debtToEquity > 2.5 ? -1 : f.debtToEquity < 0.5 ? 1 : 0;
    factors.push({ name: "Leverage", score, detail: `Debt/equity ${f.debtToEquity.toFixed(2)}` });
  }

  // 6. Long-term trend context: accumulate weakness, trim euphoria.
  if (ind.sma200 && ind.rsi14 !== undefined) {
    const dist = price / ind.sma200 - 1;
    const score = dist < -0.1 && ind.rsi14 < 40 ? 1 : dist > 0.25 && ind.rsi14 > 70 ? -2 : dist > 0.15 && ind.rsi14 > 65 ? -1 : 0;
    factors.push({
      name: "Price vs 200-day",
      score,
      detail: `${pct(dist)} from 200-day avg, RSI ${ind.rsi14.toFixed(0)}`,
    });
  }

  // 7. Street target.
  if (f.targetMeanPrice) {
    const up = f.targetMeanPrice / price - 1;
    const score = up > 0.15 ? 1 : up < -0.05 ? -1 : 0;
    factors.push({ name: "Analyst target", score, detail: `${pct(up)} to mean target ${f.targetMeanPrice.toFixed(2)} (${f.numberOfAnalysts ?? "?"} analysts)` });
  }

  const levels: RuleSignal["levels"] = {};
  if (f.dividendRate && f.fiveYearAvgDividendYield) {
    levels.buyBelow = round(f.dividendRate / (f.fiveYearAvgDividendYield * 1.1));
    levels.trimAbove = round(f.dividendRate / (f.fiveYearAvgDividendYield * 0.8));
  } else if (ind.sma200) {
    levels.buyBelow = round(ind.sma200 * 0.92);
    levels.trimAbove = round(ind.sma200 * 1.25);
  }
  return finalize("dividend", factors, levels);
}

export function swingSignal(price: number, ind: Indicators): RuleSignal {
  const factors: Factor[] = [];
  const { sma50, sma200, rsi14, macdHist, macdHistPrev, bbLower, bbUpper, atr14 } = ind;

  // 1. Trend alignment.
  if (sma50 && sma200) {
    const up = price > sma50 && sma50 > sma200;
    const down = price < sma50 && sma50 < sma200;
    factors.push({
      name: "Trend",
      score: up ? 2 : down ? -2 : price > sma50 ? 1 : -1,
      detail: `Price ${price.toFixed(2)}, 50d ${sma50.toFixed(2)}, 200d ${sma200.toFixed(2)}`,
    });
  } else if (sma50) {
    factors.push({ name: "Trend", score: price > sma50 ? 1 : -1, detail: `Price vs 50d ${sma50.toFixed(2)}` });
  }
  if (ind.goldenCross) factors.push({ name: "Golden cross", score: 1, detail: "50d crossed above 200d in the last 10 sessions" });
  if (ind.deathCross) factors.push({ name: "Death cross", score: -1, detail: "50d crossed below 200d in the last 10 sessions" });

  // 2. RSI mean-reversion, weighted by trend.
  if (rsi14 !== undefined) {
    const uptrend = sma200 ? price > sma200 : true;
    const score = rsi14 < 30 ? (uptrend ? 2 : 1) : rsi14 < 40 && uptrend ? 1 : rsi14 > 75 ? -2 : rsi14 > 68 ? -1 : 0;
    factors.push({ name: "RSI(14)", score, detail: `RSI ${rsi14.toFixed(1)}${uptrend ? " in uptrend" : " in downtrend"}` });
  }

  // 3. MACD momentum.
  if (macdHist !== undefined && macdHistPrev !== undefined) {
    const score =
      macdHistPrev <= 0 && macdHist > 0 ? 2 : macdHistPrev >= 0 && macdHist < 0 ? -2 : macdHist > 0 && macdHist > macdHistPrev ? 1 : macdHist < 0 && macdHist < macdHistPrev ? -1 : 0;
    factors.push({ name: "MACD", score, detail: `Histogram ${macdHist.toFixed(3)} (prev ${macdHistPrev.toFixed(3)})` });
  }

  // 4. Bollinger stretch.
  if (bbLower && bbUpper) {
    const score = price < bbLower ? 1 : price > bbUpper ? -1 : 0;
    factors.push({ name: "Bollinger", score, detail: `Band ${bbLower.toFixed(2)}–${bbUpper.toFixed(2)}` });
  }

  // 5. Momentum.
  if (ind.return1m !== undefined) {
    const r = ind.return1m;
    factors.push({ name: "1m momentum", score: r > 0.06 ? 1 : r < -0.06 ? -1 : 0, detail: `${pct(r)} over ~21 sessions` });
  }

  // 6. Volume confirmation.
  if (ind.volumeRatio && ind.volumeRatio > 1.5 && ind.return1m !== undefined) {
    factors.push({ name: "Volume", score: ind.return1m >= 0 ? 1 : -1, detail: `${ind.volumeRatio.toFixed(1)}x 20-day average volume` });
  }

  const levels: RuleSignal["levels"] = {};
  if (atr14) {
    levels.stopLoss = Math.floor((price - 2 * atr14) * 100 + 1e-9) / 100; // round down, matches lib/plan.ts
    levels.takeProfit = round(price + 3 * atr14);
  }
  return finalize("swing", factors, levels);
}

export function ruleSignal(strategy: Strategy, price: number, ind: Indicators, f: Fundamentals): RuleSignal {
  return strategy === "dividend" ? dividendSignal(price, ind, f) : swingSignal(price, ind);
}

const round = (v: number) => Math.round(v * 100) / 100;
