// Pure: candlestick charts as SVG for the trade team's chart analyst (trade-chartist), who looks at
// them as images, the way a trader reads a chart. Three panels: daily (60 sessions, 20/50-day
// averages), 15-minute (last 5 sessions, VWAP) and 5-minute today (VWAP, opening range, prior day's
// high and low, and the plan's trigger, stop and target). Plus the numbers a chart reader wants.
import type { IntradayBar } from "./setups";
import { nyClock } from "./setups";
import type { Bar } from "./types";

export interface ChartPlan {
  trigger?: number;
  stop?: number;
  target?: number;
}

interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  label: string; // x-axis label
  vwap?: number;
  newSession?: boolean;
}

export interface ChartFacts {
  session?: string; // the latest regular session in the 5-minute data (before the open: yesterday)
  last: number;
  priorDay?: { high: number; low: number; close: number };
  openingRange?: { high: number; low: number };
  vwap?: number;
  todayVolumeVsAvg?: number; // today's volume so far vs the average of the same bars on prior sessions
  high20d?: number;
  high60d?: number;
  roomToResistance?: { level: number; label: string; pct: number }; // nearest level above the trigger (or the last price)
  sma20?: number;
  sma50?: number;
}

const sma = (xs: number[], n: number, i: number) => (i + 1 >= n ? xs.slice(i + 1 - n, i + 1).reduce((a, b) => a + b, 0) / n : undefined);

/** Split 5-minute bars into New York sessions (regular hours only), oldest first. */
export function sessions(bars: IntradayBar[]): Array<{ date: string; bars: IntradayBar[] }> {
  const out: Array<{ date: string; bars: IntradayBar[] }> = [];
  for (const b of bars) {
    const { date, minute } = nyClock(b.t);
    if (minute < 570 || minute >= 960 || !(b.close > 0)) continue;
    if (!out.length || out[out.length - 1].date !== date) out.push({ date, bars: [] });
    out[out.length - 1].bars.push(b);
  }
  return out;
}

function withVwap(bars: IntradayBar[]): Array<IntradayBar & { vwap: number }> {
  let pv = 0, vol = 0;
  return bars.map((b) => {
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * (b.volume || 0);
    vol += b.volume || 0;
    return { ...b, vwap: vol > 0 ? pv / vol : typical };
  });
}

function to15(bars: Array<IntradayBar & { vwap: number }>): Array<IntradayBar & { vwap: number }> {
  const out: Array<IntradayBar & { vwap: number }> = [];
  for (let i = 0; i < bars.length; i += 3) {
    const g = bars.slice(i, i + 3);
    out.push({ t: g[0].t, open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[g.length - 1].close, volume: g.reduce((a, x) => a + x.volume, 0), vwap: g[g.length - 1].vwap });
  }
  return out;
}

const hhmm = (t: number) => {
  const m = nyClock(t).minute;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};

export function chartFacts(daily: Bar[], intraday: IntradayBar[], plan: ChartPlan = {}): ChartFacts {
  const ses = sessions(intraday);
  const today = ses[ses.length - 1];
  const prev = ses[ses.length - 2];
  const tv = today ? withVwap(today.bars) : [];
  const last = today?.bars[today.bars.length - 1]?.close ?? daily[daily.length - 1]?.close ?? 0;
  const closes = daily.map((d) => d.close);
  // daily bars before today (today's session may already be in the daily series)
  const todayDate = today?.date;
  const past = daily.filter((d) => d.time !== todayDate);
  const pd = prev ? { high: Math.max(...prev.bars.map((b) => b.high)), low: Math.min(...prev.bars.map((b) => b.low)), close: prev.bars[prev.bars.length - 1].close } : past.length ? { high: past[past.length - 1].high, low: past[past.length - 1].low, close: past[past.length - 1].close } : undefined;
  const or = today && today.bars.length >= 3 ? { high: Math.max(...today.bars.slice(0, 3).map((b) => b.high)), low: Math.min(...today.bars.slice(0, 3).map((b) => b.low)) } : undefined;
  const n = today?.bars.length ?? 0;
  const priorSame = ses.slice(-21, -1).map((s) => s.bars.slice(0, n).reduce((a, b) => a + b.volume, 0)).filter((v) => v > 0);
  const avgSame = priorSame.length ? priorSame.reduce((a, b) => a + b, 0) / priorSame.length : 0;
  const todayVol = today ? today.bars.reduce((a, b) => a + b.volume, 0) : 0;
  const high20d = past.length >= 20 ? Math.max(...past.slice(-20).map((d) => d.high)) : undefined;
  const high60d = past.length >= 60 ? Math.max(...past.slice(-60).map((d) => d.high)) : undefined;
  const ref = plan.trigger ?? last;
  const levels = [
    pd && { level: pd.high, label: "prior day high" },
    high20d !== undefined && { level: high20d, label: "20-day high" },
    high60d !== undefined && { level: high60d, label: "60-day high" },
  ].filter((x): x is { level: number; label: string } => !!x && x.level > ref);
  const nearest = levels.sort((a, b) => a.level - b.level)[0];
  const r2 = (x?: number) => (x === undefined ? undefined : Math.round(x * 100) / 100);
  return {
    session: today?.date,
    last: r2(last)!,
    priorDay: pd && { high: r2(pd.high)!, low: r2(pd.low)!, close: r2(pd.close)! },
    openingRange: or && { high: r2(or.high)!, low: r2(or.low)! },
    vwap: r2(tv[tv.length - 1]?.vwap),
    todayVolumeVsAvg: avgSame > 0 ? Math.round((todayVol / avgSame) * 100) / 100 : undefined,
    high20d: r2(high20d),
    high60d: r2(high60d),
    roomToResistance: nearest && { level: r2(nearest.level)!, label: nearest.label, pct: Math.round(((nearest.level - ref) / ref) * 10_000) / 100 },
    sma20: r2(sma(closes, 20, closes.length - 1)),
    sma50: r2(sma(closes, 50, closes.length - 1)),
  };
}

// ---------------------------------------------------------------- drawing

const C = { bg: "#0f1115", grid: "#232733", text: "#9aa3b2", up: "#3ecf8e", down: "#ef5d5d", vwap: "#f0b429", sma20: "#7aa7ff", sma50: "#c792ea", trigger: "#f0b429", stop: "#ef5d5d", target: "#3ecf8e", level: "#8b93a5", or: "#5ec4d6" };
const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);

interface Line {
  y: number;
  color: string;
  label: string;
  dash?: boolean;
}

function panel(x0: number, y0: number, w: number, h: number, title: string, candles: Candle[], lines: Line[], overlays: Array<{ values: Array<number | undefined>; color: string }>): string {
  const volH = Math.round(h * 0.18);
  const ph = h - volH - 22;
  const top = y0 + 22;
  // levels far from the candles would squash them: draw only the near ones, and list the rest
  const cLo = Math.min(...candles.map((c) => c.l)), cHi = Math.max(...candles.map((c) => c.h));
  const span = Math.max(cHi - cLo, cHi * 0.02);
  const near = lines.filter((l) => Number.isFinite(l.y) && l.y >= cLo - span * 0.6 && l.y <= cHi + span * 0.6);
  const far = lines.filter((l) => Number.isFinite(l.y) && !near.includes(l));
  lines = near;
  if (far.length) title += ` · off chart: ${far.map((l) => `${l.label} ${l.y.toFixed(2)}`).join(", ")}`;
  const vals = [...candles.flatMap((c) => [c.h, c.l]), ...lines.map((l) => l.y)].filter((v) => Number.isFinite(v));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
  lo -= pad;
  hi += pad;
  const y = (v: number) => top + ((hi - v) / (hi - lo)) * ph;
  const right = 78; // price labels
  const cw = (w - right) / Math.max(candles.length, 1);
  const x = (i: number) => x0 + i * cw + cw / 2;
  const vmax = Math.max(...candles.map((c) => c.v), 1);
  let s = `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="${C.bg}"/>`;
  s += `<text x="${x0 + 8}" y="${y0 + 15}" fill="#e6e9ef" font-size="13" font-weight="600">${esc(title)}</text>`;
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4;
    s += `<line x1="${x0}" x2="${x0 + w - right}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}" stroke-width="1"/>`;
    s += `<text x="${x0 + w - right + 4}" y="${y(v) + 4}" fill="${C.text}" font-size="10">${v.toFixed(2)}</text>`;
  }
  candles.forEach((c, i) => {
    if (c.newSession && i > 0) s += `<line x1="${x0 + i * cw}" x2="${x0 + i * cw}" y1="${top}" y2="${y0 + h}" stroke="${C.grid}" stroke-dasharray="3,3"/>`;
    const col = c.c >= c.o ? C.up : C.down;
    s += `<line x1="${x(i)}" x2="${x(i)}" y1="${y(c.h)}" y2="${y(c.l)}" stroke="${col}" stroke-width="1"/>`;
    const bw = Math.max(1, cw * 0.6);
    const yb = Math.min(y(c.o), y(c.c));
    s += `<rect x="${x(i) - bw / 2}" y="${yb}" width="${bw}" height="${Math.max(1, Math.abs(y(c.o) - y(c.c)))}" fill="${col}"/>`;
    const vh = (c.v / vmax) * (volH - 4);
    s += `<rect x="${x(i) - bw / 2}" y="${y0 + h - vh}" width="${bw}" height="${vh}" fill="${col}" opacity="0.45"/>`;
  });
  for (const o of overlays) {
    const pts = o.values.map((v, i) => (v === undefined ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean);
    if (pts.length > 1) s += `<polyline points="${pts.join(" ")}" fill="none" stroke="${o.color}" stroke-width="1.5"/>`;
  }
  for (const l of lines) {
    if (!Number.isFinite(l.y)) continue;
    s += `<line x1="${x0}" x2="${x0 + w - right}" y1="${y(l.y)}" y2="${y(l.y)}" stroke="${l.color}" stroke-width="1.2" ${l.dash ? 'stroke-dasharray="6,4"' : ""}/>`;
    s += `<rect x="${x0 + w - right + 1}" y="${y(l.y) - 8}" width="${right - 2}" height="15" fill="${l.color}" opacity="0.9"/>`;
    s += `<text x="${x0 + w - right + 4}" y="${y(l.y) + 3}" fill="#0f1115" font-size="10" font-weight="600">${esc(`${l.label} ${l.y.toFixed(2)}`).slice(0, 18)}</text>`;
  }
  // a few x labels
  const step = Math.max(1, Math.floor(candles.length / 6));
  candles.forEach((c, i) => {
    if (i % step === 0) s += `<text x="${x(i)}" y="${top - 4}" fill="${C.text}" font-size="9" text-anchor="middle">${esc(c.label)}</text>`;
  });
  return s;
}

export function chartSvg(symbol: string, daily: Bar[], intraday: IntradayBar[], plan: ChartPlan = {}): string {
  const W = 1200, H = 1000;
  const f = chartFacts(daily, intraday, plan);
  const d = daily.slice(-60);
  const closes = daily.map((x) => x.close);
  const off = daily.length - d.length;
  const dc: Candle[] = d.map((b) => ({ o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume, label: b.time.slice(5) }));
  const ses = sessions(intraday);
  const last5 = ses.slice(-5).flatMap((s) => to15(withVwap(s.bars)).map((b, i) => ({ ...b, newSession: i === 0, date: s.date })));
  const c15: Candle[] = last5.map((b) => ({ o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume, vwap: b.vwap, newSession: b.newSession, label: b.newSession ? b.date.slice(5) : hhmm(b.t) }));
  const today = ses[ses.length - 1];
  const tv = today ? withVwap(today.bars) : [];
  const c5: Candle[] = tv.map((b) => ({ o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume, vwap: b.vwap, label: hhmm(b.t) }));
  const planLines = ([
    plan.target !== undefined && { y: plan.target, color: C.target, label: "target" },
    plan.trigger !== undefined && { y: plan.trigger, color: C.trigger, label: "trigger" },
    plan.stop !== undefined && { y: plan.stop, color: C.stop, label: "stop" },
  ] as Array<Line | false | undefined>).filter((x): x is Line => !!x);
  const dayLines = ([
    f.high20d !== undefined && { y: f.high20d, color: C.level, label: "20d high", dash: true },
    f.priorDay && { y: f.priorDay.high, color: C.level, label: "PDH", dash: true },
    f.priorDay && { y: f.priorDay.low, color: C.level, label: "PDL", dash: true },
  ] as Array<Line | false | undefined>).filter((x): x is Line => !!x);
  const orLines: Line[] = f.openingRange ? [{ y: f.openingRange.high, color: C.or, label: "OR high", dash: true }, { y: f.openingRange.low, color: C.or, label: "OR low", dash: true }] : [];
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif"><rect width="${W}" height="${H}" fill="${C.bg}"/>`;
  s += panel(0, 0, W, 330, `${symbol} · daily, 60 sessions · blue 20-day avg, purple 50-day avg`, dc, [...dayLines.filter((l) => l.label !== "PDL"), ...planLines], [
    { values: d.map((_, i) => sma(closes, 20, off + i)), color: C.sma20 },
    { values: d.map((_, i) => sma(closes, 50, off + i)), color: C.sma50 },
  ]);
  s += panel(0, 335, W, 300, `${symbol} · 15-minute, last 5 sessions · yellow VWAP`, c15, [...dayLines, ...planLines], [{ values: c15.map((c) => c.vwap), color: C.vwap }]);
  s += panel(0, 640, W, 360, `${symbol} · 5-minute, ${today?.date ?? "no session"} · yellow VWAP · cyan opening range (first 15 min)`, c5, [...dayLines, ...orLines, ...planLines], [{ values: c5.map((c) => c.vwap), color: C.vwap }]);
  return s + "</svg>";
}
