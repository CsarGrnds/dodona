// SEC EDGAR (server only): recent filings and XBRL company facts.
// SEC asks every automated client to identify itself with a name and contact email. Dodona reads
// it from SEC_USER_AGENT (.env.local) or, like the trader skills, "sec_user_agent" in
// trader/config.json. Without one the SEC sections are skipped, never faked.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { cached } from "../cache";
import { analyse, type CompanyFacts, type EarningsReport } from "../earnings";
import { toFiling, type Filing } from "../news";

const MIN = 60_000;
const PLACEHOLDER = "you@example.com";

export async function secUserAgent(): Promise<string | undefined> {
  let ua = (process.env.SEC_USER_AGENT ?? "").trim();
  if (!ua) {
    try {
      const cfg = JSON.parse(await readFile(path.join(process.cwd(), "trader", "config.json"), "utf8"));
      ua = String(cfg?.sec_user_agent ?? "").trim();
    } catch {
      /* no config */
    }
  }
  return ua && ua.includes("@") && !ua.includes(PLACEHOLDER) ? ua : undefined;
}

async function secJson<T>(url: string, ua: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": ua, Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`SEC ${res.status} for ${new URL(url).pathname}`);
  return (await res.json()) as T;
}

/** Ticker → CIK, from SEC's company_tickers.json (cached a day). */
export async function cikFor(symbol: string, ua: string): Promise<number | undefined> {
  const map = await cached("sec:tickers", 24 * 60 * MIN, async () => {
    const raw = await secJson<Record<string, { cik_str: number; ticker: string }>>("https://www.sec.gov/files/company_tickers.json", ua);
    return new Map(Object.values(raw).map((r) => [r.ticker.toUpperCase(), r.cik_str]));
  });
  return map.get(symbol.toUpperCase()) ?? map.get(symbol.toUpperCase().replace(".", "-"));
}

interface Submissions {
  name?: string;
  filings?: { recent?: { form: string[]; filingDate: string[]; reportDate: string[]; items?: string[]; accessionNumber: string[]; primaryDocument: string[] } };
}

/** Recent filings (8-K, 10-Q, 10-K and their amendments), newest first. */
export async function recentFilings(cik: number, ua: string, max = 15): Promise<Filing[]> {
  const sub = await cached(`sec:sub:${cik}`, 30 * MIN, () => secJson<Submissions>(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`, ua));
  const r = sub.filings?.recent;
  if (!r) return [];
  const out: Filing[] = [];
  for (let i = 0; i < r.form.length && out.length < max; i++) {
    const form = r.form[i];
    if (!/^(8-K|10-Q|10-K|20-F|40-F|6-K)(\/A)?$/.test(form)) continue;
    out.push(toFiling(sub.name ?? "", { form, filed: r.filingDate[i], reportDate: r.reportDate[i], items: r.items?.[i], accession: r.accessionNumber[i], primaryDocument: r.primaryDocument[i] }, cik));
  }
  return out;
}

export async function earningsReport(cik: number, ua: string): Promise<EarningsReport | null> {
  return cached(`sec:facts:${cik}`, 6 * 60 * MIN, async () => {
    const cf = await secJson<CompanyFacts>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`, ua);
    return analyse(cf);
  });
}
