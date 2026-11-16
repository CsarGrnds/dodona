// Account performance from IBKR's Portfolio Analyst (through the Client Portal Gateway): daily net
// asset value (NAV) and time-weighted return (TWR). Pure and shared.
//
// TWR strips out deposits and withdrawals, so it measures how the investments did. The NAV change
// includes money you added or took out. The dollar gain sums each day's return on the previous
// day's value; the rest of the NAV change is net deposits (an estimate).

export const PERIODS = [
  { key: "7D", label: "1W" },
  { key: "MTD", label: "MTD" },
  { key: "1M", label: "1M" },
  { key: "YTD", label: "YTD" },
  { key: "1Y", label: "1Y" },
] as const;
export type PeriodKey = (typeof PERIODS)[number]["key"];
export const isPeriod = (p: string): p is PeriodKey => PERIODS.some((x) => x.key === p);

export interface PerfPoint {
  date: string; // YYYY-MM-DD
  nav: number;
  twr: number; // cumulative time-weighted return since the start of the period (fraction)
}

export interface Performance {
  period: PeriodKey;
  currency: string;
  start: { date: string; nav: number };
  points: PerfPoint[];
  end: number;
  navChange: number; // end − start NAV, deposits included
  twr: number; // the period's time-weighted return
  gain: number; // investment gain ≈ start NAV × TWR
  netDeposits: number; // ≈ navChange − gain
}

const iso = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d);
const r2 = (v: number) => Math.round(v * 100) / 100;

/** IBKR's /pa/performance response → Performance. Throws when the shape is unexpected. */
export function parsePerformance(raw: unknown, period: PeriodKey): Performance {
  const r = raw as {
    nav?: { dates?: string[]; data?: Array<{ navs?: number[]; startNAV?: { date?: string; val?: number }; baseCurrency?: string }> };
    cps?: { dates?: string[]; data?: Array<{ returns?: number[] }> };
  };
  const dates = r?.nav?.dates ?? [];
  const nav = r?.nav?.data?.[0];
  const navs = nav?.navs ?? [];
  const cpsDates = r?.cps?.dates ?? [];
  const returns = r?.cps?.data?.[0]?.returns ?? [];
  if (!dates.length || navs.length !== dates.length) throw new Error("IBKR performance: no NAV series");
  const twrByDate = new Map(cpsDates.map((d, i) => [d, returns[i]]));
  const points: PerfPoint[] = [];
  let lastTwr = 0;
  dates.forEach((d, i) => {
    const t = twrByDate.get(d);
    if (typeof t === "number" && Number.isFinite(t)) lastTwr = t;
    if (Number.isFinite(navs[i])) points.push({ date: iso(d), nav: r2(navs[i]), twr: lastTwr });
  });
  const startNav = Number.isFinite(nav?.startNAV?.val) ? nav!.startNAV!.val! : points[0].nav;
  const startDate = nav?.startNAV?.date ? iso(nav.startNAV.date) : points[0].date;
  const end = points[points.length - 1].nav;
  const twr = points[points.length - 1].twr;
  // Dollar gain: each day's return on the previous day's value, so money deposited mid-period
  // only earns from the day it arrived (start NAV × TWR would miss that).
  let gainSum = 0;
  let prevNav = startNav;
  let prevTwr = 0;
  for (const p of points) {
    gainSum += prevNav * ((1 + p.twr) / (1 + prevTwr) - 1);
    prevNav = p.nav;
    prevTwr = p.twr;
  }
  const gain = r2(gainSum);
  const navChange = r2(end - startNav);
  return { period, currency: nav?.baseCurrency ?? "USD", start: { date: startDate, nav: r2(startNav) }, points, end, navChange, twr, gain, netDeposits: r2(navChange - gain) };
}
