// Reported numbers from SEC XBRL company facts, ported from /trader-analyst (facts.py):
// quarterly revenue, margins, net income and diluted EPS, each against the same quarter a
// year earlier, plus the trailing twelve months. Q4 is derived as the fiscal year minus its
// three quarters when a 10-K only reports the year. Restatements win (latest filing's value).
// Pure and shared.

export const CONCEPTS: Record<string, string[]> = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "RevenuesNetOfInterestExpense",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
    "SalesRevenueGoodsNet",
    "SalesRevenueServicesNet",
  ],
  cost_of_revenue: ["CostOfGoodsAndServicesSold", "CostOfRevenue", "CostOfGoodsSold"],
  gross_profit: ["GrossProfit"],
  operating_income: ["OperatingIncomeLoss"],
  net_income: ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"],
  eps_diluted: ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"],
};
type Key = keyof typeof CONCEPTS;

export interface Fact {
  start?: string;
  end: string;
  val: number;
  form?: string;
  filed?: string;
  accn?: string;
  fy?: number;
  fp?: string;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CompanyFacts = { entityName?: string; cik?: number | string; facts?: { "us-gaap"?: Record<string, { units?: Record<string, Fact[]> }> } } & Record<string, any>;

interface QValue {
  value: number;
  start: string;
  end: string;
  derived: boolean;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
}

const day = (s: string) => Date.parse(`${s}T00:00:00Z`) / 86_400_000;
const addDay = (s: string, n: number) => new Date((day(s) + n) * 86_400_000).toISOString().slice(0, 10);

export function factsFor(cf: CompanyFacts, concept: string, unitHint: string): Fact[] {
  const units = cf.facts?.["us-gaap"]?.[concept]?.units;
  if (!units) return [];
  const unit = unitHint in units ? unitHint : Object.keys(units)[0];
  return unit ? units[unit] ?? [] : [];
}

const REPORT_FORMS = new Set(["10-Q", "10-K", "20-F", "40-F"]);

/** {start|end: fact} for duration facts from periodic reports. Value from the latest filing; fiscal label from the first. */
function periods(facts: Fact[]): Map<string, Fact & { fyFirst?: number; fpFirst?: string }> {
  const latest = new Map<string, Fact>();
  const first = new Map<string, Fact>();
  const stamp = (f: Fact) => `${f.filed ?? ""}|${f.accn ?? ""}`;
  for (const f of facts) {
    if (!f.start || !REPORT_FORMS.has((f.form ?? "").split("/")[0])) continue;
    const k = `${f.start}|${f.end}`;
    const l = latest.get(k);
    if (!l || stamp(f) > stamp(l)) latest.set(k, f);
    const fi = first.get(k);
    if (!fi || stamp(f) < stamp(fi)) first.set(k, f);
  }
  const out = new Map<string, Fact & { fyFirst?: number; fpFirst?: string }>();
  for (const [k, f] of latest) out.set(k, { ...f, fy: first.get(k)?.fy, fp: first.get(k)?.fp });
  return out;
}

export function quarterly(facts: Fact[], deriveQ4 = true): Map<string, QValue> {
  const q = new Map<string, QValue>();
  const years: Fact[] = [];
  for (const f of periods(facts).values()) {
    const days = day(f.end) - day(f.start!);
    if (days >= 80 && days <= 100) q.set(f.end, { value: f.val, start: f.start!, end: f.end, derived: false, fy: f.fy, fp: f.fp, form: f.form, filed: f.filed });
    else if (days >= 350 && days <= 380) years.push(f);
  }
  if (deriveQ4) {
    for (const f of years) {
      if (q.has(f.end)) continue;
      const inside = [...q.values()].filter((v) => v.start >= f.start! && v.end < f.end).sort((a, b) => (a.end < b.end ? -1 : 1));
      if (inside.length !== 3) continue;
      q.set(f.end, { value: f.val - inside.reduce((s, v) => s + v.value, 0), start: addDay(inside[2].end, 1), end: f.end, derived: true, fy: f.fy, fp: "Q4", form: f.form, filed: f.filed });
    }
  }
  return q;
}

export function series(cf: CompanyFacts, key: Key): Map<string, QValue> {
  const unit = key === "eps_diluted" ? "USD/shares" : "USD";
  const merged = new Map<string, QValue>();
  for (const concept of CONCEPTS[key]) {
    for (const [end, v] of quarterly(factsFor(cf, concept, unit))) if (!merged.has(end)) merged.set(end, v);
  }
  return merged;
}

function yoyMatch(s: Map<string, QValue>, end: string, days = 365, slack = 10): QValue | undefined {
  const target = day(end) - days;
  let best: [number, QValue] | undefined;
  for (const [e, v] of s) {
    const gap = Math.abs(day(e) - target);
    if (gap <= slack && (!best || gap < best[0])) best = [gap, v];
  }
  return best?.[1];
}

const pct = (a?: number, b?: number) => (a === undefined || b === undefined || b === 0 ? undefined : Math.round((1000 * (a - b)) / Math.abs(b)) / 10);
const margin = (part?: number, whole?: number) => (part === undefined || !whole ? undefined : Math.round((1000 * part) / whole) / 10);

export interface QuarterRow {
  end: string;
  start?: string;
  fiscal: string;
  derived: boolean;
  revenue?: number;
  grossProfit?: number;
  operatingIncome?: number;
  netIncome?: number;
  epsDiluted?: number;
  grossMargin?: number; // percent
  operatingMargin?: number;
  netMargin?: number;
  revenueYoY?: number; // percent
  netIncomeYoY?: number;
  epsYoY?: number;
  filed?: string;
  form?: string;
}

export interface EarningsReport {
  entity?: string;
  rows: QuarterRow[]; // newest first
  ttm: { revenue?: number; netIncome?: number; epsDiluted?: number };
  changes: string[];
}

export function analyse(cf: CompanyFacts, quarters = 6): EarningsReport | null {
  const s = Object.fromEntries((Object.keys(CONCEPTS) as Key[]).map((k) => [k, series(cf, k)])) as Record<Key, Map<string, QValue>>;
  const rev = s.revenue;
  if (!rev.size && !s.net_income.size) return null;
  const ends = [...new Set([...rev.keys(), ...s.net_income.keys()])].sort().reverse().slice(0, quarters);
  const rows: QuarterRow[] = ends.map((end) => {
    const r = rev.get(end)?.value;
    let gp = s.gross_profit.get(end)?.value;
    if (gp === undefined && r !== undefined && s.cost_of_revenue.has(end)) gp = r - s.cost_of_revenue.get(end)!.value;
    const oi = s.operating_income.get(end)?.value;
    const ni = s.net_income.get(end)?.value;
    const eps = s.eps_diluted.get(end)?.value;
    const base = rev.get(end) ?? s.net_income.get(end);
    return {
      end,
      start: base?.start,
      fiscal: `${base?.fp ?? ""} ${base?.fy ?? ""}`.trim(),
      derived: Boolean(rev.get(end)?.derived || s.net_income.get(end)?.derived),
      revenue: r,
      grossProfit: gp,
      operatingIncome: oi,
      netIncome: ni,
      epsDiluted: eps !== undefined ? Math.round(eps * 100) / 100 : undefined,
      grossMargin: margin(gp, r),
      operatingMargin: margin(oi, r),
      netMargin: margin(ni, r),
      revenueYoY: pct(r, yoyMatch(rev, end)?.value),
      netIncomeYoY: pct(ni, yoyMatch(s.net_income, end)?.value),
      epsYoY: pct(eps, yoyMatch(s.eps_diluted, end)?.value),
      filed: base?.filed,
      form: base?.form,
    };
  });
  const ttm: EarningsReport["ttm"] = {};
  for (const [key, out] of [["revenue", "revenue"], ["net_income", "netIncome"], ["eps_diluted", "epsDiluted"]] as const) {
    const last4 = [...s[key].keys()].sort().slice(-4);
    if (last4.length === 4 && day(last4[3]) - day(last4[0]) < 300) {
      const sum = last4.reduce((a, e) => a + s[key].get(e)!.value, 0);
      ttm[out] = key === "eps_diluted" ? Math.round(sum * 100) / 100 : sum;
    }
  }
  const report: EarningsReport = { entity: cf.entityName, rows, ttm, changes: [] };
  report.changes = changes(report);
  return report;
}

export const money = (v?: number) => (v === undefined ? "n/a" : Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : `$${(v / 1e6).toFixed(1)}M`);
const signed = (v: number, digits = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;

/** Plain sentences: what changed in the latest quarter. */
export function changes(r: EarningsReport): string[] {
  const [cur, prev] = r.rows;
  if (!cur) return [];
  const out: string[] = [];
  let line = `Quarter ending ${cur.end}${cur.derived ? " (derived from the 10-K)" : ""}: revenue ${money(cur.revenue)}`;
  if (cur.revenueYoY !== undefined) line += ` (${signed(cur.revenueYoY)}% vs a year earlier)`;
  line += `, net income ${money(cur.netIncome)}`;
  if (cur.netIncomeYoY !== undefined) line += ` (${signed(cur.netIncomeYoY)}%)`;
  if (cur.epsDiluted !== undefined) {
    line += `, diluted EPS $${cur.epsDiluted.toFixed(2)}`;
    if (cur.epsYoY !== undefined) line += ` (${signed(cur.epsYoY)}%)`;
  }
  out.push(`${line}.`);
  for (const [k, name] of [["grossMargin", "Gross margin"], ["operatingMargin", "Operating margin"], ["netMargin", "Net margin"]] as const) {
    const v = cur[k];
    if (v === undefined) continue;
    const p = prev?.[k];
    out.push(`${name} ${v.toFixed(1)}%${p !== undefined ? ` (${signed(v - p)} points vs the quarter before)` : ""}.`);
  }
  if (cur.netIncome !== undefined && cur.operatingIncome !== undefined && cur.netIncome > cur.operatingIncome)
    out.push("Net income is above operating income: it includes gains outside the business (investments, tax items). Check the 10-Q before reading it as growth.");
  if (prev && cur.revenue !== undefined && prev.revenue)
    out.push(`Revenue ${signed(pct(cur.revenue, prev.revenue)!)}% vs the quarter before (many businesses are seasonal: compare with a year earlier first).`);
  return out;
}
