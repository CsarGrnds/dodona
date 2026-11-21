// Draw a stock's chart for the trade team's chart analyst (trade-chartist): a PNG it reads as an
// image, plus the numbers a chart reader wants, as JSON. Real Yahoo data (and SEC EDGAR filings when
// a SEC user agent is set); nothing is traded.
//
//   npm run -s chart -- TSLA [--trigger 364.18 --stop 358.32 --target 370.04] [--out DIR]
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { chartFacts, chartSvg, filingEvents, type ChartContext } from "../lib/chart";
import { tradingDaysBetween } from "../lib/clock";
import { getDailyHistory, getFundamentals, getIntraday, getMarketBars } from "../lib/data";
import { cikFor, recentFilings, secUserAgent } from "../lib/data/sec";
import { nyClock } from "../lib/setups";

const argv = process.argv.slice(2);
const flag = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const num = (k: string) => (flag(k) !== undefined && Number.isFinite(Number(flag(k))) ? Number(flag(k)) : undefined);

/** SPY, the next earnings date and the last filings. Each is optional: a missing source is a note, never a guess. */
async function context(symbol: string, notes: string[]): Promise<ChartContext> {
  const [spy, fund, filings] = await Promise.all([
    symbol === "SPY" ? Promise.resolve(undefined) : getMarketBars().catch(() => (notes.push("SPY bars unavailable"), undefined)),
    getFundamentals(symbol).catch(() => (notes.push("next earnings date unavailable"), undefined)),
    (async () => {
      const ua = await secUserAgent();
      if (!ua) return (notes.push("no SEC user agent: filings not marked"), undefined);
      const cik = await cikFor(symbol, ua);
      if (!cik) return (notes.push("not an SEC filer: filings not marked"), undefined);
      return recentFilings(cik, ua, 25);
    })().catch(() => (notes.push("SEC filings unavailable"), undefined)),
  ]);
  return { spy, nextEarnings: fund?.nextEarningsDate, earningsEstimated: fund?.earningsDateEstimated, events: filings ? filingEvents(filings) : undefined, tradingDays: tradingDaysBetween };
}

async function main() {
  const symbol = (argv.find((a) => !a.startsWith("--") && !argv[argv.indexOf(a) - 1]?.startsWith("--")) ?? "").toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) throw new Error("usage: npm run -s chart -- SYMBOL [--trigger P --stop P --target P] [--out DIR]");
  const plan = { trigger: num("trigger"), stop: num("stop"), target: num("target") };
  const notes: string[] = [];
  const [daily, intraday, ctx] = await Promise.all([getDailyHistory(symbol), getIntraday(symbol), context(symbol, notes)]);
  if (!daily.length) throw new Error(`no daily bars for ${symbol}`);
  const svg = chartSvg(symbol, daily, intraday, plan, ctx);
  const dir = resolve(process.cwd(), flag("out") ?? "trader/charts");
  await mkdir(dir, { recursive: true });
  const { date, minute } = nyClock(Date.now());
  const file = join(dir, `${symbol}-${date}-${String(Math.floor(minute / 60)).padStart(2, "0")}${String(minute % 60).padStart(2, "0")}.png`);
  await writeFile(file, await sharp(Buffer.from(svg)).png().toBuffer());
  console.log(JSON.stringify({ symbol, chart: file, plan, facts: chartFacts(daily, intraday, plan, ctx), ...(notes.length ? { notes } : {}) }, null, 2));
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
