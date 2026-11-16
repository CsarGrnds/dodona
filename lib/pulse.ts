// Portfolio pulse: who's winning, who's losing, and why the account is up or down. Pure and shared.
//
// Attribution is arithmetic, not a story: each holding's dollar move (shares × price change),
// what the market alone would explain (value × beta × SPY's move), the sectors the move came
// from, and the latest headline for any stock that moved 3%+ (a headline is a lead, not proof
// of the cause).

export const BIG_MOVE = 0.03; // a single-stock move worth explaining
export const DOMINANT = 0.5; // one holding or sector carrying half the move

export interface PulseHolding {
  ticker: string;
  name?: string;
  shares: number;
  avgCost: number;
  price: number;
  change: number; // dollars per share vs the previous close
  changePct: number; // fraction
  sector?: string;
  beta?: number;
  headline?: { title: string; link: string; publisher?: string; publishedAt?: string };
  nextEarnings?: string;
  error?: string;
}

export interface Mover {
  ticker: string;
  name?: string;
  pnl: number; // dollars
  pct: number; // fraction (today's change, or vs average cost for total)
  value: number;
  headline?: PulseHolding["headline"];
}

export interface Pulse {
  day: { pnl: number; pct: number; prevValue: number; marketPct?: number; marketExplains?: number; stockSpecific?: number };
  total: { pnl: number; pct: number; cost: number };
  winners: Mover[]; // today, best first
  losers: Mover[]; // today, worst first
  totalWinners: Mover[]; // since you bought
  totalLosers: Mover[];
  sectors: Array<{ sector: string; pnl: number }>; // today, by |pnl|
  why: string[]; // plain-language reading of the day
  whyTotal: string[]; // plain-language reading of the total
}

const usd = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}%`;
const r2 = (v: number) => Math.round(v * 100) / 100;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export function pulse(holdings: PulseHolding[], marketPct?: number, top = 5): Pulse {
  const ok = holdings.filter((h) => !h.error && h.price > 0 && h.shares > 0);
  const day = ok.map((h) => ({ h, pnl: h.shares * h.change, prev: h.shares * (h.price - h.change), value: h.shares * h.price }));
  const dayPnl = day.reduce((s, x) => s + x.pnl, 0);
  const prevValue = day.reduce((s, x) => s + x.prev, 0);
  const dayPct = prevValue > 0 ? dayPnl / prevValue : 0;

  const tot = ok.map((h) => ({ h, pnl: h.shares * (h.price - h.avgCost), cost: h.shares * h.avgCost, value: h.shares * h.price }));
  const totPnl = tot.reduce((s, x) => s + x.pnl, 0);
  const totCost = tot.reduce((s, x) => s + x.cost, 0);

  const mv = (x: { h: PulseHolding; pnl: number; value: number }, pctV: number): Mover => ({ ticker: x.h.ticker, name: x.h.name, pnl: r2(x.pnl), pct: pctV, value: r2(x.value), headline: x.h.headline });
  const dayMovers = day.map((x) => mv(x, x.h.changePct));
  const totMovers = tot.map((x) => mv(x, x.h.avgCost > 0 ? x.h.price / x.h.avgCost - 1 : 0));
  const winners = dayMovers.filter((m) => m.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, top);
  const losers = dayMovers.filter((m) => m.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, top);
  const totalWinners = totMovers.filter((m) => m.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, top);
  const totalLosers = totMovers.filter((m) => m.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, top);

  const bySector = new Map<string, number>();
  for (const x of day) bySector.set(x.h.sector ?? "Other / ETF", (bySector.get(x.h.sector ?? "Other / ETF") ?? 0) + x.pnl);
  const sectors = [...bySector].map(([sector, pnl]) => ({ sector, pnl: r2(pnl) })).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));

  // Market attribution: what each holding "should" have done given SPY and its beta (1 when unknown).
  let marketExplains: number | undefined;
  if (marketPct !== undefined) marketExplains = r2(day.reduce((s, x) => s + x.prev * (x.h.beta ?? 1) * marketPct, 0));
  const stockSpecific = marketExplains !== undefined ? r2(dayPnl - marketExplains) : undefined;

  // ---- the day, in words
  const why: string[] = [];
  const dir = dayPnl >= 0 ? "up" : "down";
  if (Math.abs(dayPnl) < 0.005) why.push("Flat: no change since the previous close.");
  else {
    why.push(`The portfolio is ${dir} ${usd(dayPnl).slice(1)} (${pct(dayPct)}) from the previous close.`);
    if (marketPct !== undefined && marketExplains !== undefined && stockSpecific !== undefined) {
      const sameWay = Math.sign(marketExplains) === Math.sign(dayPnl);
      const share = Math.abs(marketExplains) / Math.max(Math.abs(dayPnl), 1e-9);
      if (sameWay && share >= 0.7) why.push(`Mostly the market: SPY ${pct(marketPct)}; at your holdings' betas that alone accounts for about ${usd(marketExplains)}.`);
      else if (sameWay) why.push(`Partly the market: SPY ${pct(marketPct)} accounts for about ${usd(marketExplains)}; the other ${usd(stockSpecific)} is your stocks' own moves.`);
      else why.push(`Against the market: SPY ${pct(marketPct)} would suggest ${usd(marketExplains)}, so your stocks' own moves (${usd(stockSpecific)}) drove the day.`);
    }
    const drivers = (dayPnl >= 0 ? winners : losers).slice(0, 3);
    if (drivers.length) {
      const share = drivers.reduce((s, m) => s + m.pnl, 0) / dayPnl;
      why.push(`${dayPnl >= 0 ? "Gains" : "Losses"} came mainly from ${list(drivers.map((m) => `${m.ticker} ${usd(m.pnl)} (${pct(m.pct)})`))}${share > 0 && share < 1 ? `: ${Math.round(share * 100)}% of the move` : ""}.`);
      const lead = drivers[0];
      if (Math.abs(lead.pnl) > Math.abs(dayPnl)) {
        why.push(`${lead.ticker} alone (${usd(lead.pnl)}) is more than the whole day's ${usd(dayPnl)}: without it the portfolio would be ${dayPnl >= 0 ? "down" : "up"}. One position decides your day.`);
      } else if (Math.abs(lead.pnl) >= DOMINANT * Math.abs(dayPnl)) {
        why.push(`${lead.ticker} alone is ${Math.round((lead.pnl / dayPnl) * 100)}% of the day: concentration risk.`);
      }
    }
    const against = (dayPnl >= 0 ? losers : winners).slice(0, 2);
    if (against.length) why.push(`${dayPnl >= 0 ? "Held back" : "Cushioned"} by ${list(against.map((m) => `${m.ticker} ${usd(m.pnl)}`))}.`);
    const sec = sectors[0];
    if (sec && Math.sign(sec.pnl) === Math.sign(dayPnl) && Math.abs(sec.pnl) >= DOMINANT * Math.abs(dayPnl)) why.push(`By sector, ${sec.sector} carried it (${usd(sec.pnl)}).`);
  }
  for (const h of ok) {
    if (Math.abs(h.changePct) >= BIG_MOVE) {
      why.push(`${h.ticker} moved ${pct(h.changePct)}${h.headline ? `. Latest headline: “${h.headline.title}”${h.headline.publisher ? ` (${h.headline.publisher})` : ""}` : ", with no headline in the feed"}.`);
    }
  }

  // ---- since you bought, in words
  const whyTotal: string[] = [];
  if (totCost > 0) {
    whyTotal.push(`Since you bought: ${usd(totPnl)} (${pct(totPnl / totCost)}) on ${usd(totCost).slice(1)} invested.`);
    if (totalWinners.length) whyTotal.push(`Carried by ${list(totalWinners.slice(0, 3).map((m) => `${m.ticker} ${usd(m.pnl)}`))}.`);
    if (totalLosers.length) whyTotal.push(`Dragged by ${list(totalLosers.slice(0, 3).map((m) => `${m.ticker} ${usd(m.pnl)} (${pct(m.pct)})`))}.`);
    const lead = (totPnl >= 0 ? totalWinners : totalLosers)[0];
    if (lead && Math.abs(lead.pnl) > Math.abs(totPnl)) {
      whyTotal.push(`${lead.ticker} alone (${usd(lead.pnl)}) is more than the whole ${usd(totPnl)}: without it you'd be ${usd(totPnl - lead.pnl)}.`);
    }
    const under = totMovers.filter((m) => m.pnl < 0).length;
    whyTotal.push(`${totMovers.length - under} of ${totMovers.length} positions are above their cost.`);
  }

  return {
    day: { pnl: r2(dayPnl), pct: dayPct, prevValue: r2(prevValue), marketPct, marketExplains, stockSpecific },
    total: { pnl: r2(totPnl), pct: totCost > 0 ? totPnl / totCost : 0, cost: r2(totCost) },
    winners,
    losers,
    totalWinners,
    totalLosers,
    sectors,
    why,
    whyTotal,
  };
}
