// Server-only: the research tools Claude can call while it decides on the paper desk. All of them
// only READ market data (Yahoo through Dodona's cached data layer) or the desk's own ledger.
// None can place, change or size a trade. Every tool sees the market only up to `nowMs`, so a
// replayed session can't peek at the future.
import type Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_ORB_PARAMS, DEFAULT_SWING_PARAMS, orbBacktest, swingBacktest } from "../backtest";
import type { DeskState } from "../desk";
import { r2 } from "../desk";
import { computeIndicators } from "../indicators";
import { supportResistance } from "../levels";
import { marketAt, marketBefore, marketSeries, relativeStrength } from "../market";
import { clockLabel, findSwingSetups, nyClock, orbHit, SETUP_LABEL, splitSessions, type IntradayBar } from "../setups";
import type { Bar } from "../types";
import { getDailyHistory, getIntraday, getMarketBars, getSnapshot, normalizeSymbol } from "./index";

export interface ToolContext {
  nowMs: number;
  today: string; // New York date of nowMs
  desk: DeskState;
}

export const SECTOR_ETFS: Record<string, string> = {
  XLK: "Technology", XLF: "Financials", XLE: "Energy", XLV: "Health care", XLY: "Consumer discretionary", XLP: "Consumer staples",
  XLI: "Industrials", XLU: "Utilities", XLB: "Materials", XLRE: "Real estate", XLC: "Communication services", SMH: "Semiconductors",
};

const sym = (v: unknown) => normalizeSymbol(String(v ?? ""));
const num = (v: unknown, d: number, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};
const rnd = (v?: number, k = 4) => (v === undefined || !Number.isFinite(v) ? undefined : Math.round(v * 10 ** k) / 10 ** k);

/** Completed daily bars before today, and today's 5-minute bars up to now. */
async function bars(symbol: string, ctx: ToolContext) {
  const [daily, intra] = await Promise.all([getDailyHistory(symbol).catch(() => [] as Bar[]), getIntraday(symbol).catch(() => [] as IntradayBar[])]);
  const done = daily.filter((b) => b.time < ctx.today);
  const sessions = splitSessions(intra, ctx.nowMs);
  const todaySession = sessions.at(-1)?.date === ctx.today ? sessions.at(-1) : undefined;
  return { daily: done, sessions, todaySession };
}

function aggregate(b: IntradayBar[], n: number): IntradayBar[] {
  const out: IntradayBar[] = [];
  for (let i = 0; i < b.length; i += n) {
    const g = b.slice(i, i + n);
    out.push({ t: g[0].t, open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[g.length - 1].close, volume: g.reduce((a, x) => a + x.volume, 0) });
  }
  return out;
}

const dayChange = (daily: Bar[], last?: number) => (last !== undefined && daily.length ? rnd(last / daily[daily.length - 1].close - 1) : undefined);

export const DESK_TOOLS: Anthropic.Beta.BetaTool[] = ([
  {
    name: "get_daily_chart",
    description:
      "Daily OHLCV candles for a US stock or ETF (completed sessions only, oldest first), plus today's session so far as one partial candle. Use it to read trend, structure (higher highs/lows, bases, flags), gaps and volume before taking or managing a trade.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["symbol", "days"],
      properties: { symbol: { type: "string", description: "Ticker, e.g. AAPL" }, days: { type: "integer", description: "How many sessions back, 20-250" } },
    },
  },
  {
    name: "get_intraday_chart",
    description:
      "Today's regular-session bars so far (New York time) at 5, 15 or 30 minutes, with the opening range (first 15 minutes), VWAP and the session's high/low. Pass sessions_back=1 for the previous session instead. Use it to judge a breakout's quality, where buyers and sellers stepped in, and how an open position is behaving.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["symbol", "minutes", "sessions_back"],
      properties: {
        symbol: { type: "string" },
        minutes: { type: "integer", enum: [5, 15, 30] },
        sessions_back: { type: "integer", description: "0 = today, 1 = the previous session, up to 5" },
      },
    },
  },
  {
    name: "get_levels_and_indicators",
    description:
      "Indicators on the daily chart (SMA 20/50/200, RSI 14, MACD histogram, ATR 14, Bollinger bands, returns, volume vs 20-day average, 52-week range), support and resistance levels with their touch counts, and relative strength against SPY over 3 months.",
    input_schema: { type: "object", additionalProperties: false, required: ["symbol"], properties: { symbol: { type: "string" } } },
  },
  {
    name: "get_setup_track_record",
    description:
      "Which daily setups fired on the last completed session (20-day breakout, bull flag, reclaimed 20-day average, oversold, oversold bounce), whether today's opening-range breakout has triggered, and how each setup actually played out on THIS stock over the last ~3 years (daily) and ~60 sessions (opening range): trades, win rate, average R. Use it to tell an edge from noise.",
    input_schema: { type: "object", additionalProperties: false, required: ["symbol"], properties: { symbol: { type: "string" } } },
  },
  {
    name: "get_news_and_events",
    description: "Recent headlines (newest first), the next earnings date (gap risk for anything held over it), sector, industry, market cap, beta and analyst view.",
    input_schema: { type: "object", additionalProperties: false, required: ["symbol"], properties: { symbol: { type: "string" } } },
  },
  {
    name: "get_market_overview",
    description:
      "The market backdrop: SPY's trend (vs its 50- and 200-day averages, 3-month return), today's move so far for SPY, QQQ, IWM and the sector ETFs (XLK, XLF, XLE, XLV, XLY, XLP, XLI, XLU, XLB, XLRE, XLC, SMH), ranked. Use it to trade with the tape and the strongest groups.",
    input_schema: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
  {
    name: "get_desk_history",
    description:
      "This paper desk's own record: closed trades (setup, entry, exit, why it closed, P&L, R), optionally for one symbol, plus results by setup. Use it to learn from what has and hasn't worked on this desk.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["symbol"],
      properties: { symbol: { type: ["string", "null"], description: "One ticker, or null for all" } },
    },
  },
] as Anthropic.Beta.BetaTool[]).map((t) => ({ ...t, strict: true }));

export async function runDeskTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  switch (name) {
    case "get_daily_chart": {
      const s = sym(input.symbol);
      const n = num(input.days, 60, 20, 250);
      const { daily, todaySession } = await bars(s, ctx);
      if (!daily.length) throw new Error(`no daily data for ${s}`);
      const t = todaySession?.bars;
      return {
        symbol: s,
        columns: ["date", "open", "high", "low", "close", "volume"],
        candles: daily.slice(-n).map((b) => [b.time, r2(b.open), r2(b.high), r2(b.low), r2(b.close), Math.round(b.volume)]),
        todaySoFar: t?.length ? { date: ctx.today, open: r2(t[0].open), high: r2(Math.max(...t.map((b) => b.high))), low: r2(Math.min(...t.map((b) => b.low))), last: r2(t[t.length - 1].close), volume: Math.round(t.reduce((a, b) => a + b.volume, 0)), changeFromYesterday: dayChange(daily, t[t.length - 1].close) } : null,
      };
    }
    case "get_intraday_chart": {
      const s = sym(input.symbol);
      const step = [5, 15, 30].includes(Number(input.minutes)) ? Number(input.minutes) : 5;
      const back = num(input.sessions_back, 0, 0, 5);
      const { sessions, daily } = await bars(s, ctx);
      const past = sessions.filter((x) => x.date < ctx.today);
      const sess = back === 0 ? sessions.find((x) => x.date === ctx.today) : past[past.length - back];
      if (!sess || !sess.bars.length) return { symbol: s, note: back === 0 ? "No bars for today's session yet (pre-market or market closed)." : "No bars for that session." };
      const b = sess.bars;
      const or = b.slice(0, DEFAULT_ORB_PARAMS.orBars);
      let pv = 0;
      let vol = 0;
      for (const x of b) {
        pv += ((x.high + x.low + x.close) / 3) * x.volume;
        vol += x.volume;
      }
      const prevClose = daily.filter((d) => d.time < sess.date).at(-1)?.close;
      return {
        symbol: s,
        session: sess.date,
        complete: sess.full,
        prevClose: rnd(prevClose, 2),
        openingRange: or.length === DEFAULT_ORB_PARAMS.orBars ? { high: r2(Math.max(...or.map((x) => x.high))), low: r2(Math.min(...or.map((x) => x.low))) } : null,
        vwap: vol ? r2(pv / vol) : null,
        high: r2(Math.max(...b.map((x) => x.high))),
        low: r2(Math.min(...b.map((x) => x.low))),
        last: r2(b[b.length - 1].close),
        columns: ["time", "open", "high", "low", "close", "volume"],
        bars: aggregate(b, step / 5).map((x) => [clockLabel(nyClock(x.t).minute), r2(x.open), r2(x.high), r2(x.low), r2(x.close), Math.round(x.volume)]),
      };
    }
    case "get_levels_and_indicators": {
      const s = sym(input.symbol);
      const [{ daily, todaySession }, spy] = await Promise.all([bars(s, ctx), getMarketBars().catch(() => [] as Bar[])]);
      if (daily.length < 30) throw new Error(`not enough daily history for ${s}`);
      const price = todaySession?.bars.at(-1)?.close ?? daily[daily.length - 1].close;
      const ind = computeIndicators(daily, price);
      const ms = spy.length ? marketSeries(spy.filter((b) => b.time < ctx.today)) : undefined;
      const lv = supportResistance(daily, price, ind.atr14, { max: 4 });
      return {
        symbol: s,
        price: r2(price),
        indicators: Object.fromEntries(Object.entries(ind).map(([k, v]) => [k, typeof v === "number" ? rnd(v) : v])),
        supports: lv.supports.map((l) => ({ price: r2(l.price), touches: l.touches, lastTouch: l.lastDate, distancePct: rnd(l.distancePct) })),
        resistances: lv.resistances.map((l) => ({ price: r2(l.price), touches: l.touches, lastTouch: l.lastDate, distancePct: rnd(l.distancePct) })),
        relativeStrength3mVsSpy: ms ? rnd(relativeStrength(daily, daily.length - 1, ms)) : null,
      };
    }
    case "get_setup_track_record": {
      const s = sym(input.symbol);
      const [{ daily, sessions, todaySession }, spy] = await Promise.all([bars(s, ctx), getMarketBars().catch(() => [] as Bar[])]);
      if (daily.length < 60) throw new Error(`not enough daily history for ${s}`);
      const ms = spy.length ? marketSeries(spy) : undefined;
      const found = findSwingSetups(daily.map((b) => b.close));
      const bt = swingBacktest(daily, DEFAULT_SWING_PARAMS, ms);
      const orb = orbBacktest(sessions.filter((x) => x.full && x.date !== ctx.today), DEFAULT_ORB_PARAMS, ms, daily);
      const hit = todaySession ? orbHit(todaySession.bars, DEFAULT_ORB_PARAMS.orBars) : null;
      const rec = (r: (typeof orb)["record"]) => ({ trades: r.trades, winRate: rnd(r.winRate, 2), avgR: r.avgR, sample: r.sample, verdict: r.verdict });
      return {
        symbol: s,
        lastCompletedSession: daily[daily.length - 1].time,
        firedOnLastSession: found?.tags.map((t) => SETUP_LABEL[t]) ?? [],
        swingRules: `entry at the setup's close, stop ${DEFAULT_SWING_PARAMS.stopAtr}×ATR below, target ${DEFAULT_SWING_PARAMS.targetR}R, ${DEFAULT_SWING_PARAMS.maxHoldDays}-session time stop`,
        swingRecord: Object.fromEntries(Object.entries(bt.bySetup).map(([k, r]) => [SETUP_LABEL[k as keyof typeof SETUP_LABEL], rec(r)])),
        buyAndHoldBaseline: bt.baseline,
        openingRangeToday: hit ? { triggeredAt: clockLabel(hit.atMinute), entry: hit.price, orHigh: hit.orHigh, orLow: hit.orLow } : todaySession ? "not triggered" : "no session today yet",
        openingRangeRecord: { rules: `entry on the first 5-minute close above the first 15 minutes' high, stop at the range midpoint, target ${DEFAULT_ORB_PARAMS.targetR}R, out at the close`, sessions: orb.sessions, ...rec(orb.record) },
      };
    }
    case "get_news_and_events": {
      const s = sym(input.symbol);
      const snap = await getSnapshot(s);
      const f = snap.fundamentals;
      const cutoff = ctx.nowMs;
      return {
        symbol: s,
        name: snap.quote.name,
        nextEarningsDate: f.nextEarningsDate ?? null,
        earningsDateEstimated: f.earningsDateEstimated ?? null,
        sector: f.sector ?? null,
        industry: f.industry ?? null,
        marketCap: f.marketCap ?? null,
        beta: rnd(f.beta, 2) ?? null,
        analysts: f.recommendationKey ? { consensus: f.recommendationKey, count: f.numberOfAnalysts, meanTarget: f.targetMeanPrice } : null,
        headlines: snap.news
          .filter((n) => !n.publishedAt || Date.parse(n.publishedAt) <= cutoff)
          .slice(0, 10)
          .map((n) => ({ when: n.publishedAt ?? null, title: n.title, publisher: n.publisher ?? null })),
      };
    }
    case "get_market_overview": {
      const spy = await getMarketBars().catch(() => [] as Bar[]);
      const ms = spy.length ? marketSeries(spy) : undefined;
      const backdrop = ms ? marketBefore(ms, ctx.today) ?? marketAt(ms) : undefined;
      const names = ["SPY", "QQQ", "IWM", ...Object.keys(SECTOR_ETFS)];
      const moves = await Promise.all(
        names.map(async (n) => {
          try {
            const { daily, todaySession } = await bars(n, ctx);
            const last = todaySession?.bars.at(-1)?.close;
            const r1m = daily.length > 21 ? rnd(daily[daily.length - 1].close / daily[daily.length - 22].close - 1) : undefined;
            return { symbol: n, name: SECTOR_ETFS[n] ?? n, today: dayChange(daily, last) ?? null, month: r1m ?? null };
          } catch {
            return { symbol: n, name: SECTOR_ETFS[n] ?? n, today: null, month: null };
          }
        }),
      );
      return {
        spyTrend: backdrop ?? null,
        todayRanked: moves.filter((m) => m.today !== null).sort((a, b) => (b.today ?? 0) - (a.today ?? 0)),
        noIntradayYet: moves.filter((m) => m.today === null).map((m) => m.symbol),
      };
    }
    case "get_desk_history": {
      const one = input.symbol ? sym(input.symbol) : undefined;
      const trades = ctx.desk.trades.filter((t) => !one || t.symbol === one);
      const by = new Map<string, { trades: number; pnl: number; wins: number; R: number }>();
      for (const t of ctx.desk.trades) {
        const g = by.get(t.setup) ?? { trades: 0, pnl: 0, wins: 0, R: 0 };
        g.trades++;
        g.pnl += t.pnl;
        g.R += t.R;
        if (t.pnl > 0) g.wins++;
        by.set(t.setup, g);
      }
      return {
        closedTrades: trades.slice(-25).reverse().map((t) => ({ symbol: t.symbol, setup: t.setup, style: t.style, by: t.by, opened: t.openedAt, closed: t.exitAt, entry: t.entry, exit: t.exit, reason: t.reason, exitNote: t.exitNote, pnl: t.pnl, R: t.R, thesis: t.thesis })),
        bySetup: [...by.entries()].map(([setup, g]) => ({ setup, trades: g.trades, winRate: rnd(g.wins / g.trades, 2), avgR: rnd(g.R / g.trades, 2), pnl: r2(g.pnl) })),
        totalClosed: ctx.desk.trades.length,
      };
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

/** A short label for the research log, e.g. "daily chart NVDA (120d)". */
export function toolLabel(name: string, input: Record<string, unknown>): string {
  const s = typeof input.symbol === "string" ? ` ${input.symbol.toUpperCase()}` : "";
  switch (name) {
    case "get_daily_chart":
      return `daily chart${s} (${input.days ?? 60}d)`;
    case "get_intraday_chart":
      return `${input.minutes ?? 5}-min chart${s}${Number(input.sessions_back) ? ` (${input.sessions_back} back)` : ""}`;
    case "get_levels_and_indicators":
      return `levels & indicators${s}`;
    case "get_setup_track_record":
      return `setup track record${s}`;
    case "get_news_and_events":
      return `news & earnings${s}`;
    case "get_market_overview":
      return "market & sectors";
    case "get_desk_history":
      return `desk history${s || " (all)"}`;
    default:
      return name;
  }
}

