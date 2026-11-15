import { NextResponse } from "next/server";
import { DEFAULT_ORB_PARAMS, DEFAULT_SWING_PARAMS, orbBacktest, swingBacktest } from "@/lib/backtest";
import { getDailyHistory, getIntraday, normalizeSymbol } from "@/lib/data";
import { atr } from "@/lib/indicators";
import { CLOSE_MIN, findSwingSetups, nyClock, orbHit, orMidStop, splitSessions } from "@/lib/setups";
import type { Bar } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const numParam = (u: URLSearchParams, k: string, d: number, lo: number, hi: number) => {
  const v = Number(u.get(k));
  return Number.isFinite(v) && v >= lo && v <= hi && u.get(k) !== null ? v : d;
};

// GET /api/setups?symbol=TSLA[&stopAtr=2&targetR=2&maxHold=20]
// Swing setups on the last completed daily bar + their track record on this stock, and the
// opening-range breakout in the latest session + its track record over the last ~60 sessions.
export async function GET(req: Request) {
  const u = new URL(req.url).searchParams;
  let symbol: string;
  try {
    symbol = normalizeSymbol(u.get("symbol") ?? "");
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  const swingParams = {
    stopAtr: numParam(u, "stopAtr", DEFAULT_SWING_PARAMS.stopAtr, 0.25, 10),
    targetR: numParam(u, "targetR", DEFAULT_SWING_PARAMS.targetR, 0.25, 10),
    maxHoldDays: numParam(u, "maxHold", DEFAULT_SWING_PARAMS.maxHoldDays, 1, 120),
  };
  const orbParams = { ...DEFAULT_ORB_PARAMS, targetR: swingParams.targetR };
  const now = Date.now();
  const nowNy = nyClock(now);
  const warnings: string[] = [];

  const [daily, intra] = await Promise.all([
    getDailyHistory(symbol).catch((e) => {
      warnings.push(`Daily history unavailable: ${e.message}`);
      return [] as Bar[];
    }),
    getIntraday(symbol).catch((e) => {
      warnings.push(`5-minute bars unavailable: ${e.message}`);
      return [];
    }),
  ]);

  // Swing: only COMPLETE daily bars (drop today's bar while the session is still open).
  let bars = daily;
  const dow = new Date(now).getUTCDay();
  if (bars.length && bars[bars.length - 1].time === nowNy.date && dow !== 0 && dow !== 6 && nowNy.minute < CLOSE_MIN) bars = bars.slice(0, -1);
  const closes = bars.map((b) => b.close);
  const found = findSwingSetups(closes);
  const atr14 = atr(bars).at(-1);
  const swing = found
    ? {
        lastDate: bars[bars.length - 1].time,
        close: closes[closes.length - 1],
        atr14: Number.isFinite(atr14) ? atr14 : undefined,
        tags: found.tags,
        numbers: found.numbers,
        backtest: swingBacktest(bars, swingParams),
      }
    : null;
  if (!found && bars.length) warnings.push(`Only ${bars.length} daily bars: need 30 for swing setups.`);

  // Intraday: the latest session's opening-range breakout + history over the full sessions.
  const sessions = splitSessions(intra, now);
  const latest = sessions.at(-1);
  let intraday = null;
  if (latest) {
    const inProgress = latest.date === nowNy.date && nowNy.minute < CLOSE_MIN && !latest.full;
    const hit = orbHit(latest.bars, orbParams.orBars);
    const lastBar = latest.bars.at(-1);
    const orHigh = latest.bars.length >= orbParams.orBars ? Math.max(...latest.bars.slice(0, orbParams.orBars).map((b) => b.high)) : undefined;
    const orLow = latest.bars.length >= orbParams.orBars ? Math.min(...latest.bars.slice(0, orbParams.orBars).map((b) => b.low)) : undefined;
    const status = hit ? "triggered" : latest.bars.length < orbParams.orBars ? "forming" : inProgress ? "waiting" : "no-breakout";
    intraday = {
      session: { date: latest.date, bars: latest.bars.length, full: latest.full, inProgress },
      status,
      orHigh,
      orLow,
      lastPrice: lastBar?.close,
      hit,
      stop: hit ? orMidStop(hit.orHigh, hit.orLow) : orHigh !== undefined && orLow !== undefined ? orMidStop(orHigh, orLow) : undefined,
      backtest: orbBacktest(sessions.filter((s) => !(s.date === latest.date && inProgress)), orbParams),
    };
  }

  return NextResponse.json({ symbol, asOf: new Date(now).toISOString(), swing, intraday, warnings }, { headers: { "Cache-Control": "no-store" } });
}
