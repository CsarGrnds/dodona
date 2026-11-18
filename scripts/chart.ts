// Draw a stock's chart for the trade team's chart analyst (trade-chartist): a PNG it reads as an
// image, plus the numbers a chart reader wants, as JSON. Real Yahoo data; nothing is traded.
//
//   npm run -s chart -- TSLA [--trigger 364.18 --stop 358.32 --target 370.04] [--out DIR]
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { chartFacts, chartSvg } from "../lib/chart";
import { getDailyHistory, getIntraday } from "../lib/data";
import { nyClock } from "../lib/setups";

const argv = process.argv.slice(2);
const flag = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const num = (k: string) => (flag(k) !== undefined && Number.isFinite(Number(flag(k))) ? Number(flag(k)) : undefined);

async function main() {
  const symbol = (argv.find((a) => !a.startsWith("--") && !argv[argv.indexOf(a) - 1]?.startsWith("--")) ?? "").toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) throw new Error("usage: npm run -s chart -- SYMBOL [--trigger P --stop P --target P] [--out DIR]");
  const plan = { trigger: num("trigger"), stop: num("stop"), target: num("target") };
  const [daily, intraday] = await Promise.all([getDailyHistory(symbol), getIntraday(symbol)]);
  if (!daily.length) throw new Error(`no daily bars for ${symbol}`);
  const svg = chartSvg(symbol, daily, intraday, plan);
  const dir = resolve(process.cwd(), flag("out") ?? "trader/charts");
  await mkdir(dir, { recursive: true });
  const { date, minute } = nyClock(Date.now());
  const file = join(dir, `${symbol}-${date}-${String(Math.floor(minute / 60)).padStart(2, "0")}${String(minute % 60).padStart(2, "0")}.png`);
  await writeFile(file, await sharp(Buffer.from(svg)).png().toBuffer());
  console.log(JSON.stringify({ symbol, chart: file, plan, facts: chartFacts(daily, intraday, plan) }, null, 2));
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
