import type { Bar, Indicators } from "./types";

const last = <T>(a: T[]): T | undefined => a[a.length - 1];

export function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : NaN);
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out: number[] = [];
  const k = 2 / (period + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(NaN);
    } else if (i === period - 1) {
      prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
      out.push(prev);
    } else {
      prev = values[i] * k + prev * (1 - k);
      out.push(prev);
    }
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(values: number[], period = 14): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(values: number[], fast = 12, slow = 26, signal = 9) {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = values.map((_, i) => f[i] - s[i]);
  const firstValid = line.findIndex((v) => Number.isFinite(v));
  const sig: number[] = new Array(values.length).fill(NaN);
  if (firstValid >= 0) {
    const e = ema(line.slice(firstValid), signal);
    e.forEach((v, i) => (sig[firstValid + i] = v));
  }
  const hist = line.map((v, i) => v - sig[i]);
  return { line, signal: sig, hist };
}

export function atr(bars: Bar[], period = 14): number[] {
  const tr = bars.map((b, i) =>
    i === 0
      ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)),
  );
  const out: number[] = new Array(bars.length).fill(NaN);
  if (bars.length < period) return out;
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

function stdev(values: number[]): number {
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length);
}

const fin = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : undefined);

function pctReturn(closes: number[], sessionsBack: number): number | undefined {
  if (closes.length <= sessionsBack) return undefined;
  const then = closes[closes.length - 1 - sessionsBack];
  return then ? closes[closes.length - 1] / then - 1 : undefined;
}

/** Crossed within the last `lookback` sessions. */
function crossed(a: number[], b: number[], dir: "up" | "down", lookback = 10): boolean {
  for (let i = Math.max(1, a.length - lookback); i < a.length; i++) {
    if (![a[i], b[i], a[i - 1], b[i - 1]].every(Number.isFinite)) continue;
    if (dir === "up" && a[i - 1] <= b[i - 1] && a[i] > b[i]) return true;
    if (dir === "down" && a[i - 1] >= b[i - 1] && a[i] < b[i]) return true;
  }
  return false;
}

export function computeIndicators(bars: Bar[], livePrice?: number): Indicators {
  if (bars.length === 0) return {};
  const closes = bars.map((b) => b.close);
  if (livePrice && Number.isFinite(livePrice)) closes[closes.length - 1] = livePrice;
  const price = last(closes)!;

  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const m = macd(closes);
  const r = rsi(closes);
  const a = atr(bars);

  const window = closes.slice(-252);
  const high52w = Math.max(...bars.slice(-252).map((b) => b.high));
  const low52w = Math.min(...bars.slice(-252).map((b) => b.low));
  let bbUpper: number | undefined;
  let bbLower: number | undefined;
  if (closes.length >= 20) {
    const sd = stdev(closes.slice(-20));
    bbUpper = last(s20)! + 2 * sd;
    bbLower = last(s20)! - 2 * sd;
  }
  const vols = bars.map((b) => b.volume);
  const avgVol = vols.length >= 21 ? vols.slice(-21, -1).reduce((x, y) => x + y, 0) / 20 : undefined;

  return {
    sma20: fin(last(s20)),
    sma50: fin(last(s50)),
    sma200: fin(last(s200)),
    ema12: fin(last(ema(closes, 12))),
    ema26: fin(last(ema(closes, 26))),
    rsi14: fin(last(r)),
    macd: fin(last(m.line)),
    macdSignal: fin(last(m.signal)),
    macdHist: fin(last(m.hist)),
    macdHistPrev: fin(m.hist[m.hist.length - 2]),
    bbUpper,
    bbLower,
    atr14: fin(last(a)),
    high52w,
    low52w,
    drawdownFromHigh: high52w ? price / high52w - 1 : undefined,
    return1m: pctReturn(window, 21),
    return3m: pctReturn(window, 63),
    return1y: pctReturn(window, Math.min(251, window.length - 1)),
    volumeRatio: avgVol ? last(vols)! / avgVol : undefined,
    goldenCross: crossed(s50, s200, "up"),
    deathCross: crossed(s50, s200, "down"),
  };
}
