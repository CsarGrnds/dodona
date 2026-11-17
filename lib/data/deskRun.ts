// Server-only: one desk cycle. Mark and exit open paper positions from real 5-minute bars, scan
// for setups, let Claude (or the rules engine) pick, then size and risk-check every entry in
// code before it is booked. PAPER ONLY: nothing here calls a broker.
import { DEFAULT_ORB_PARAMS, DEFAULT_SWING_PARAMS, orbBacktest, swingBacktest, type TrackRecord } from "../backtest";
import { marketStatus, tradingDay, tradingDaysBetween } from "../clock";
import {
  buyFill,
  closePosition,
  dailyRoom,
  equityOf,
  feeCheck,
  floorCents,
  log,
  markDay,
  minuteOf,
  openPosition,
  raiseStop,
  riskGate,
  sizeTrade,
  type Agent,
  type AgentSession,
  SESSIONS_MAX,
  type DeskRules,
  type DeskState,
  type PriceBar,
  type Style,
  findExit,
  r2,
  rulesVerdict,
} from "../desk";
import { deskAgentEnabled, deskModel, runDeskAgent, type CandidateInput, type DeskDecision, type PositionInput } from "../deskAgent";
import { atr, computeIndicators } from "../indicators";
import { supportResistance } from "../levels";
import { marketBefore, marketSeries, relativeStrength, type MarketContext } from "../market";
import { CLOSE_MIN, clockLabel, findSwingSetups, nyClock, orbHit, orMidStop, SETUP_LABEL, splitSessions, SWING_SETUPS, type IntradayBar, type SwingSetup } from "../setups";
import type { Bar } from "../types";
import { setLiveSession } from "./deskLive";
import { getDailyHistory, getIntraday, getMarketBars, getQuote } from "./index";

/** Liquid US names, many under $150 so a small account can buy whole shares. */
export const DESK_UNIVERSE = [
  "SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMD", "AMZN", "GOOGL", "META", "TSLA", "PLTR", "SOFI", "F", "BAC", "INTC", "T", "PFE",
  "UBER", "HOOD", "NU", "CSCO", "KO", "WBD", "CCL", "AAL", "RIVN", "SNAP", "MARA", "XOM",
];
const PARALLEL = 4;
const MAX_SYMBOLS = 40;
const AGENT_CANDIDATES = 6;
const REVIEW_EVERY_MS = 15 * 60_000; // Claude re-reads open positions at most every 15 minutes
const ORB_FRESH_BARS = 3; // a breakout older than 15 minutes is stale
const SWING_TAGS: SwingSetup[] = ["breakout_20d", "bull_flag", "reclaim_ma20", "oversold_bounce"];

export interface RunReport {
  at: string;
  market: { open: boolean; reason: string };
  agent: Agent;
  model?: string;
  agentError?: string;
  scanned: number;
  candidates: Array<{ key: string; symbol: string; setup: string; style: Style; price: number; record?: Pick<TrackRecord, "trades" | "avgR" | "winRate" | "sample" | "verdict"> }>;
  tooPricey: string[];
  exits: number;
  entries: number;
  notes: string[];
  sessionId?: string; // Claude's session this run, when it ran
}

interface Scan extends CandidateInput {
  setupKey: string;
  marketTrend?: MarketContext["trend"];
}

const bars5 = (b: IntradayBar[]): PriceBar[] => b.map((x) => ({ t: x.t, open: x.open, high: x.high, low: x.low, close: x.close, minutes: 5 }));
const ohlc = (b: Bar): [string, number, number, number, number, number] => [b.time, r2(b.open), r2(b.high), r2(b.low), r2(b.close), Math.round(b.volume)];
const iso = (ms: number) => new Date(ms).toISOString();

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

export async function runDesk(s: DeskState, rules: DeskRules, opts: { symbols?: string[]; nowMs?: number; useAgent?: boolean; manageOnly?: boolean }): Promise<RunReport> {
  const nowMs = opts.nowMs ?? Date.now();
  const at = iso(nowMs);
  const ms = marketStatus(nowMs);
  const { date: today, minute } = nyClock(nowMs);
  const useClaude = opts.useAgent !== false && deskAgentEnabled();
  const replay = opts.nowMs !== undefined; // a pinned clock (tests, replays): fill at the bar prices, not today's live quote
  const report: RunReport = { at, market: { open: ms.open, reason: ms.reason }, agent: useClaude ? "claude" : "rules", model: useClaude ? deskModel() : undefined, scanned: 0, candidates: [], tooPricey: [], exits: 0, entries: 0, notes: [] };
  const flatBy = minuteOf(rules.flat_by);

  // ---- 1. open positions: replay real bars for stops, targets, flat-by and time stops
  for (const p of [...s.positions]) {
    let intra: IntradayBar[] = [];
    try {
      intra = await getIntraday(p.symbol);
    } catch (e) {
      report.notes.push(`${p.symbol}: 5-minute bars unavailable (${e instanceof Error ? e.message : e}); kept as is.`);
    }
    const bars = bars5(intra).sort((a, b) => a.t - b.t);
    const hit = findExit(p, bars, flatBy, nowMs);
    const last = [...bars].reverse().find((b) => b.t + 5 * 60_000 <= nowMs);
    if (last) {
      p.lastPrice = last.close;
      p.lastAt = iso(last.t + 5 * 60_000);
    }
    if (hit) {
      const t = closePosition(s, p.id, hit.price, iso(hit.at), hit.reason, hit.note);
      if (t) {
        report.exits++;
        log(s, { kind: "sell", symbol: t.symbol, by: "desk", text: `Sold ${t.qty} ${t.symbol} at $${t.exit.toFixed(2)}: ${hit.note}. ${t.pnl >= 0 ? "+" : "−"}$${Math.abs(t.pnl).toFixed(2)} (${t.R >= 0 ? "+" : ""}${t.R}R).` }, t.exitAt);
      }
      continue;
    }
    const dayOver = p.style === "day" && (today !== p.entryDate || minute >= flatBy);
    const timeUp = p.style === "swing" && tradingDaysBetween(p.entryDate, today) >= p.maxHoldDays && (ms.open || minute >= CLOSE_MIN);
    if (dayOver || timeUp) {
      const note = dayOver ? `day trade past the ${rules.flat_by} flat-by time` : `time stop: ${p.maxHoldDays} sessions without hitting the stop or target`;
      const t = closePosition(s, p.id, p.lastPrice, at, dayOver ? "flat-by" : "time", note);
      if (t) {
        report.exits++;
        log(s, { kind: "sell", symbol: t.symbol, by: "desk", text: `Sold ${t.qty} ${t.symbol} at $${t.exit.toFixed(2)}: ${note}. ${t.pnl >= 0 ? "+" : "−"}$${Math.abs(t.pnl).toFixed(2)} (${t.R >= 0 ? "+" : ""}${t.R}R).` }, at);
      }
    }
  }

  // ---- 2. scan for setups (only while new entries are possible)
  const opened = s.positions.filter((x) => x.entryDate === today).length + s.trades.filter((t) => t.entryDate === today).length;
  const manageOnly = opts.manageOnly ?? s.driver === "team"; // the trade team makes its own entries
  const canEnter = !manageOnly && ms.open && minute >= minuteOf(rules.no_entries_before) && minute <= minuteOf(rules.no_entries_after) && opened < rules.max_trades_per_day && dailyRoom(rules, s, nowMs) > 0.01;
  let market: MarketContext | undefined;
  const spy = await getMarketBars().catch(() => [] as Bar[]);
  const mser = spy.length ? marketSeries(spy) : undefined;
  if (mser) market = marketBefore(mser, today); // yesterday's close, like the completed daily bars
  const scans: Scan[] = [];
  if (canEnter) {
    const symbols = [...new Set([...(opts.symbols ?? []), ...DESK_UNIVERSE])].slice(0, MAX_SYMBOLS);
    const maxPrice = rules.fractional ? Infinity : Math.min((rules.budget * rules.max_position_pct) / 100, rules.max_order_usd);
    const found = await pool(symbols, PARALLEL, async (sym) => {
      try {
        return await scanSymbol(sym, today, nowMs, mser, market);
      } catch {
        return [] as Scan[];
      }
    });
    report.scanned = symbols.length;
    for (const list of found)
      for (const c of list) {
        if (c.price > maxPrice) {
          if (!report.tooPricey.includes(c.symbol)) report.tooPricey.push(c.symbol);
          continue;
        }
        if (s.positions.some((p) => p.symbol === c.symbol)) continue;
        scans.push(c);
      }
    scans.sort((a, b) => (b.record?.avgR ?? -9) - (a.record?.avgR ?? -9));
    report.candidates = scans.map((c) => ({ key: c.key, symbol: c.symbol, setup: c.setup, style: c.style, price: c.price, record: c.record && { trades: c.record.trades, avgR: c.record.avgR, winRate: c.record.winRate, sample: c.record.sample, verdict: c.record.verdict } }));
  } else if (manageOnly) report.notes.push("The Claude Code trade team makes the entries (/trade-desk): Dodona only marks positions and runs their stops, targets and flat-by time.");
  else if (!ms.open) report.notes.push(`Market ${ms.reason}: no new entries, positions marked from the latest bars.`);
  else if (opened >= rules.max_trades_per_day) report.notes.push(`Trade limit reached (${rules.max_trades_per_day} today): managing open positions only.`);
  else if (dailyRoom(rules, s, nowMs) <= 0.01) report.notes.push(`Daily loss limit ($${rules.max_daily_loss_usd}) used up: no new entries today.`);
  else report.notes.push(`Outside the entry window (${rules.no_entries_before}–${rules.no_entries_after} New York): managing open positions only.`);

  const fresh = scans.filter((c) => !s.reviewed[c.key]);

  // ---- 3. decide
  let decision: DeskDecision | undefined;
  if (useClaude && !manageOnly && ms.open && (fresh.length || (s.positions.length && (!s.lastAgentAt || nowMs - Date.parse(s.lastAgentAt) >= REVIEW_EVERY_MS)))) {
    const shortlist = fresh.slice(0, AGENT_CANDIDATES);
    // Claude fetches charts, news and levels itself with its tools; it starts from a short brief.
    const positions: PositionInput[] = s.positions.map((p) => ({ id: p.id, symbol: p.symbol, style: p.style, setup: p.setup, qty: p.qty, entry: p.entry, stop: p.stop, target: p.target, price: p.lastPrice, openedAt: p.openedAt, thesis: p.thesis }));
    const trigger = [shortlist.length ? `${shortlist.length} new setup${shortlist.length === 1 ? "" : "s"}: ${shortlist.map((c) => `${c.symbol} (${c.setup})`).join(", ")}` : "", s.positions.length ? `${s.positions.length} open position${s.positions.length === 1 ? "" : "s"} to review` : ""].filter(Boolean).join(" · ");
    const session: AgentSession = { id: `S-${nowMs.toString(36)}`, startedAt: at, model: deskModel(), status: "running", trigger, steps: [], toolCalls: 0, rounds: 0, usage: { input: 0, output: 0, cacheRead: 0 } };
    s.sessions = [session, ...(s.sessions ?? [])].slice(0, SESSIONS_MAX);
    report.sessionId = session.id;
    setLiveSession(session);
    try {
      decision = await runDeskAgent(
        {
          now: `${ms.weekday} ${today} ${clockLabel(minute)} New York`,
          rules,
          account: { equity: equityOf(s), cash: s.cash, dailyRoom: r2(dailyRoom(rules, s, nowMs)), tradesLeftToday: Math.max(0, rules.max_trades_per_day - opened) },
          market,
          candidates: shortlist.map(({ setupKey: _k, marketTrend: _m, daily: _d, intraday: _i, levels: _l, ...c }) => c),
          positions,
          recentTrades: s.trades.slice(-10).map((t) => ({ symbol: t.symbol, setup: t.setup, pnl: t.pnl, R: t.R, reason: t.reason, date: t.exitDate })),
        },
        { nowMs, today, desk: s },
        session,
        () => setLiveSession(session),
      );
      session.status = "done";
      session.summary = decision.summary;
      s.lastAgentAt = at;
      if (decision.summary) s.lastSummary = decision.summary;
      for (const c of shortlist) s.reviewed[c.key] = at;
    } catch (e) {
      report.agentError = e instanceof Error ? e.message : String(e);
      session.status = "error";
      session.error = report.agentError;
      session.steps.push({ at: new Date().toISOString(), kind: "error", title: "Session failed", detail: report.agentError });
      report.notes.push(`Claude unavailable (${report.agentError}): the rules engine decided this round.`);
    } finally {
      session.endedAt = new Date().toISOString();
      setLiveSession(session);
    }
  }

  // ---- 4a. manage positions
  if (decision && ms.open) {
    for (const d of decision.positions) {
      const p = s.positions.find((x) => x.id === d.id);
      if (!p) continue;
      if (d.action === "close") {
        const px = replay ? p.lastPrice : await getQuote(p.symbol).then((q) => q.price).catch(() => p.lastPrice);
        const t = closePosition(s, p.id, px, at, "agent", d.why);
        if (t) {
          report.exits++;
          log(s, { kind: "sell", symbol: t.symbol, by: "claude", text: `Closed ${t.qty} ${t.symbol} at $${t.exit.toFixed(2)}: ${d.why} ${t.pnl >= 0 ? "+" : "−"}$${Math.abs(t.pnl).toFixed(2)} (${t.R >= 0 ? "+" : ""}${t.R}R).` }, at);
        }
      } else if (d.action === "raise_stop" && d.new_stop !== null) {
        const r = raiseStop(p, d.new_stop);
        log(s, { kind: r.ok ? "stop-raised" : "note", symbol: p.symbol, by: "claude", text: r.ok ? `${p.symbol}: ${r.why}. ${d.why}` : `${p.symbol}: kept the stop (${r.why}). ${d.why}` }, at);
      } else if (d.action === "hold" && d.why) {
        log(s, { kind: "hold", symbol: p.symbol, by: "claude", text: `${p.symbol}: hold. ${d.why}` }, at);
      }
    }
  } else if (!decision && ms.open) {
    // rules engine: move the stop to break-even once the trade is 1R in profit
    for (const p of s.positions.filter((x) => x.by === "rules")) {
      const risk = p.entry - p.initialStop;
      if (risk > 0 && p.lastPrice >= p.entry + risk && p.stop < p.entry) {
        const r = raiseStop(p, Math.ceil(p.entry * 100) / 100);
        if (r.ok) log(s, { kind: "stop-raised", symbol: p.symbol, by: "rules", text: `${p.symbol}: 1R in profit, ${r.why} (break-even).` }, at);
      }
    }
  }

  // ---- 4b. entries
  const picks: Array<{ c: Scan; stop: number; target: number; why: string; by: Agent; confidence?: number }> = [];
  if (decision) {
    for (const d of decision.entries) {
      const c = fresh.find((x) => x.key === d.key);
      if (!c) continue;
      if (d.decision === "skip") {
        log(s, { kind: "skip", symbol: c.symbol, by: "claude", text: `Skipped ${c.symbol} ${c.setup}: ${d.why}` }, at);
        continue;
      }
      picks.push({ c, stop: d.stop ?? c.suggested.stop, target: d.target ?? c.suggested.target, why: d.why, by: "claude", confidence: d.confidence });
    }
  } else if (canEnter) {
    for (const c of fresh) {
      s.reviewed[c.key] = at;
      const v = rulesVerdict(c);
      if (!v.take) {
        log(s, { kind: "skip", symbol: c.symbol, by: "rules", text: `Skipped ${c.symbol} ${c.setup}: ${v.why}` }, at);
        continue;
      }
      picks.push({ c, stop: c.suggested.stop, target: c.suggested.target, why: v.why, by: "rules" });
    }
  }

  for (const pk of picks) {
    const { c } = pk;
    const live = replay ? c.price : await getQuote(c.symbol).then((q) => q.price).catch(() => c.price);
    const entry = buyFill(live);
    const stop = floorCents(pk.stop);
    const target = r2(pk.target);
    const gate = riskGate(rules, s, { symbol: c.symbol, style: c.style, entry, stop, target }, nowMs, ms.open);
    if (!gate.ok) {
      log(s, { kind: "blocked", symbol: c.symbol, by: pk.by, text: `Wanted ${c.symbol} (${c.setup}), blocked: ${gate.reason}.` }, at);
      continue;
    }
    const sz = sizeTrade(rules, entry, stop, s.cash, equityOf(s));
    if ("refused" in sz) {
      log(s, { kind: "blocked", symbol: c.symbol, by: pk.by, text: `Wanted ${c.symbol} (${c.setup}), no size: ${sz.refused}.` }, at);
      continue;
    }
    // the trade's max loss must also fit what's left of today's loss limit
    const room = dailyRoom(rules, s, nowMs);
    let qty = sz.qty;
    if (sz.maxLoss > room) qty = rules.fractional ? Math.floor((room / (entry - stop)) * 10_000) / 10_000 : Math.floor(room / (entry - stop));
    if (qty <= 0) {
      log(s, { kind: "blocked", symbol: c.symbol, by: pk.by, text: `Wanted ${c.symbol}, blocked: one share's risk is more than the $${room.toFixed(2)} left under today's loss limit.` }, at);
      continue;
    }
    const fee = qty < sz.qty ? feeCheck(qty, entry - stop) : undefined;
    if (fee) {
      log(s, { kind: "blocked", symbol: c.symbol, by: pk.by, text: `Wanted ${c.symbol}, cut to fit today's loss limit and now ${fee}.` }, at);
      continue;
    }
    const pos = openPosition(s, { symbol: c.symbol, style: c.style, setup: c.setup, qty, entry, stop, target, openedAt: at, entryDate: today, maxHoldDays: c.style === "swing" ? DEFAULT_SWING_PARAMS.maxHoldDays : 1, by: pk.by, confidence: pk.confidence, thesis: pk.why }, at);
    report.entries++;
    const rr = (target - entry) / (entry - stop);
    log(s, { kind: "buy", symbol: c.symbol, by: pk.by, text: `Bought ${qty} ${c.symbol} at $${entry.toFixed(2)} (${c.setup}, ${c.style}). Stop $${stop.toFixed(2)}, target $${target.toFixed(2)}, ${rr.toFixed(1)}:1, max loss $${(qty * (entry - stop)).toFixed(2)}${qty < sz.qty ? " (cut to fit today's loss limit)" : ` (size set by ${sz.decidedBy})`}. ${pk.why}` }, pos.openedAt);
  }

  // ---- 5. history
  if (tradingDay(today).ok) markDay(s, nowMs);
  for (const [k, v] of Object.entries(s.reviewed)) if (nowMs - Date.parse(v) > 4 * 86_400_000) delete s.reviewed[k];
  s.lastRunAt = at;
  return report;
}

function intradayRows(b: IntradayBar[]): CandidateInput["intraday"] {
  return b.map((x) => {
    const { minute } = nyClock(x.t);
    return [clockLabel(minute), r2(x.open), r2(x.high), r2(x.low), r2(x.close), Math.round(x.volume)];
  });
}

async function scanSymbol(symbol: string, today: string, nowMs: number, mser: ReturnType<typeof marketSeries> | undefined, market: MarketContext | undefined): Promise<Scan[]> {
  const [daily, intra] = await Promise.all([getDailyHistory(symbol).catch(() => [] as Bar[]), getIntraday(symbol).catch(() => [] as IntradayBar[])]);
  // completed daily bars only
  const bars = daily.filter((b) => b.time < today);
  if (bars.length < 60) return [];
  const sessions = splitSessions(intra, nowMs);
  const latest = sessions.at(-1);
  const lastBar = latest?.date === today ? latest.bars.at(-1) : undefined;
  const price = lastBar?.close ?? bars[bars.length - 1].close;
  const ind = computeIndicators(bars, price);
  const atr14 = atr(bars).at(-1);
  const levels = supportResistance(bars, price, ind.atr14);
  const rs = mser ? relativeStrength(bars, bars.length - 1, mser) : undefined;
  const indicators = {
    sma20: rnd(ind.sma20), sma50: rnd(ind.sma50), sma200: rnd(ind.sma200), rsi14: rnd(ind.rsi14), atr14: rnd(ind.atr14), macdHist: rnd(ind.macdHist),
    volumeRatio: rnd(ind.volumeRatio), return1m: rnd(ind.return1m), return3m: rnd(ind.return3m), high52w: rnd(ind.high52w), low52w: rnd(ind.low52w),
  };
  const base = { symbol, price: r2(price), daily: bars.slice(-60).map(ohlc), indicators, levels, relativeStrength3m: rnd(rs), marketTrend: market?.trend };
  const out: Scan[] = [];

  // day: a fresh opening-range breakout in today's session
  if (latest && latest.date === today) {
    const hit = orbHit(latest.bars, DEFAULT_ORB_PARAMS.orBars);
    if (hit && hit.barIndex >= latest.bars.length - ORB_FRESH_BARS && price > hit.orHigh * 0.998) {
      const stop = orMidStop(hit.orHigh, hit.orLow);
      if (stop < price) {
        const record = orbBacktest(sessions.filter((x) => x.full && x.date !== today), DEFAULT_ORB_PARAMS, mser, bars).record;
        out.push({
          ...base,
          key: `${today}:${symbol}:orb`,
          setupKey: "orb",
          style: "day",
          setup: "Opening-range breakout",
          setupRule: `A 5-minute bar closed above the first 15 minutes' high ($${hit.orHigh.toFixed(2)}) at ${clockLabel(hit.atMinute)}; opening-range low $${hit.orLow.toFixed(2)}`,
          suggested: { stop, target: r2(price + DEFAULT_ORB_PARAMS.targetR * (price - stop)) },
          record,
          intraday: intradayRows(latest.bars),
        });
      }
    }
  }

  // swing: yesterday's close made a daily setup
  const found = findSwingSetups(bars.map((b) => b.close));
  const tags = found?.tags.filter((t) => SWING_TAGS.includes(t)) ?? [];
  if (tags.length && atr14 && Number.isFinite(atr14)) {
    const bt = swingBacktest(bars, DEFAULT_SWING_PARAMS, mser);
    const best = tags.reduce((a, t) => (bt.bySetup[t].avgR > bt.bySetup[a].avgR ? t : a), tags[0]);
    const stop = floorCents(price - DEFAULT_SWING_PARAMS.stopAtr * atr14);
    out.push({
      ...base,
      key: `${today}:${symbol}:${best}`,
      setupKey: best,
      style: "swing",
      setup: SETUP_LABEL[best],
      setupRule: SWING_SETUPS.find((x) => x.key === best)!.rule + (tags.length > 1 ? ` (also: ${tags.filter((t) => t !== best).map((t) => SETUP_LABEL[t]).join(", ")})` : ""),
      suggested: { stop, target: r2(price + DEFAULT_SWING_PARAMS.targetR * (price - stop)) },
      record: bt.bySetup[best],
      intraday: latest?.date === today ? intradayRows(latest.bars) : undefined,
    });
  }
  return out;
}

const rnd = (v?: number) => (v === undefined || !Number.isFinite(v) ? undefined : Math.round(v * 10_000) / 10_000);
