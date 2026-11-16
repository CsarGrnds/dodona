import type { EarningsReport } from "./earnings";

// News tagging and SEC 8-K item labels, ported from /trader-news. Pure and shared.

export const ITEMS_8K: Record<string, string> = {
  "1.01": "material agreement",
  "1.02": "agreement ended",
  "1.03": "bankruptcy",
  "1.05": "cybersecurity incident",
  "2.01": "acquisition or sale of assets",
  "2.02": "earnings results",
  "2.03": "new debt",
  "2.04": "debt acceleration",
  "2.05": "restructuring costs",
  "2.06": "impairment",
  "3.01": "delisting notice",
  "3.02": "unregistered share sale",
  "3.03": "shareholder rights change",
  "4.01": "auditor change",
  "4.02": "past financials no longer reliable",
  "5.01": "change in control",
  "5.02": "director or officer change",
  "5.03": "bylaws or fiscal year change",
  "5.07": "shareholder vote results",
  "7.01": "Regulation FD disclosure",
  "8.01": "other events",
  "9.01": "exhibits",
};
export const IMPORTANT_ITEMS = new Set(["1.03", "1.05", "2.02", "2.04", "2.06", "3.01", "4.02", "5.01", "5.02"]);

export const NEWS_TAGS: Array<[tag: string, rx: RegExp]> = [
  ["earnings", /\bearnings\b|\bresults\b|\bEPS\b|\bguidance\b|\bforecast\b/i],
  ["analyst", /\bupgrade[sd]?\b|\bdowngrade[sd]?\b|price target|\boutperform\b|\bunderperform\b/i],
  ["legal", /\blawsuit\b|\bsued\b|\bprobe\b|\binvestigation\b|\bSEC charges\b|\bantitrust\b|\bjudge\b|\bcourt\b/i],
  ["deal", /\bacqui(?:re|res|red|sition)\b|\bmerger\b|\bbuyout\b|\btakeover\b|\bdeal\b/i],
  ["capital", /\bdividend\b|\bbuyback\b|\brepurchase\b|\bstock split\b|\boffering\b/i],
  ["people", /\bCEO\b|\bCFO\b|\bresign|\bsteps down\b|\bappoint/i],
  ["risk", /\brecall\b|\bbankrupt|\bdefault\b|\bdelist|\bhack|\bbreach\b|\boutage\b/i],
  ["halt", /\bhalt(?:s|ed)?\b|\btrading (?:pause|suspen)/i],
  ["regulatory", /\bFDA\b|\bapproval\b|\bapproves\b|\bclinical\b|\bFTC\b|\bDOJ\b/i],
  ["macro", /\bFed\b|\bFOMC\b|\bCPI\b|\binflation\b|\bjobs report\b|\bpayrolls\b|\btariffs?\b|\bfutures\b/i],
];
/** Tags that are a reason to look twice before entering. */
export const RISK_TAGS = new Set(["legal", "risk", "halt"]);
/** trader-news flags a stock this far from yesterday's close as moving. */
export const MOVE_PCT = 0.03;

export function tagText(text: string): string[] {
  return NEWS_TAGS.filter(([, rx]) => rx.test(text)).map(([t]) => t);
}

export interface Filing {
  form: string; // 8-K, 10-Q, 10-K, ...
  filed: string; // YYYY-MM-DD
  reportDate?: string;
  items: string[]; // 8-K item numbers
  labels: string[]; // plain-language item labels (exhibits left out)
  important: boolean;
  tags: string[];
  title: string;
  link: string;
}

/** One row of EDGAR's submissions "recent" table → a Filing. */
export function toFiling(company: string, row: { form: string; filed: string; reportDate?: string; items?: string; accession: string; primaryDocument?: string }, cik: number): Filing {
  const items: string[] = (row.items ?? "").match(/\d+\.\d+/g) ?? [];
  const labels = items.filter((i) => i !== "9.01").map((i) => ITEMS_8K[i] ?? `item ${i}`);
  const acc = row.accession.replace(/-/g, "");
  const link = row.primaryDocument ? `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${row.primaryDocument}` : `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/`;
  const title = `${company} filed a ${row.form}${labels.length ? `: ${labels.join(", ")}` : ""}`;
  const tags = tagText(title);
  if (items.includes("2.02") && !tags.includes("earnings")) tags.unshift("earnings");
  return { form: row.form, filed: row.filed, reportDate: row.reportDate || undefined, items, labels, important: items.some((i) => IMPORTANT_ITEMS.has(i)), tags, title, link };
}

/** What /api/research returns. */
export interface ResearchResult {
  symbol: string;
  sec: "ok" | "no-user-agent" | "not-found" | "error";
  filings: Filing[];
  earnings: EarningsReport | null;
  warnings: string[];
}
