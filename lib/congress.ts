// Congress trades (STOCK Act), ported from /trader-pelosi (ptr.py). Pure and shared.
//   index — the House Clerk's <YEAR>FD.xml: one <Member> per filing (name, district, type, date, DocID)
//   PTR   — a Periodic Transaction Report PDF, as layout text, turned into rows: owner, asset,
//           ticker, buy/sell, trade date, amount range, options, days it took to disclose.
// Fast, not early: a PTR is due up to 45 days after the trade. Public filings only.

export const INDEX_URL = (year: number) => `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`;
export const PTR_URL = (year: number, docId: string) => `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`;
export const TXN_TYPES: Record<string, string> = { P: "purchase", S: "sale", "S (partial)": "partial sale", E: "exchange" };
export const OWNERS: Record<string, string> = { SP: "spouse", JT: "joint", DC: "dependent child", "": "self" };
export const LATE_DAYS = 45;

export interface IndexRow {
  docId: string;
  type: string; // P = periodic transaction report
  last: string;
  first: string;
  name: string;
  district: string;
  year: number;
  filed?: string; // YYYY-MM-DD
  url: string;
}

export interface Trade {
  owner: string; // SP, JT, DC or ""
  ownerName: string;
  asset: string;
  ticker?: string;
  assetType?: string; // ST stock, OP option, ...
  type: string; // P, S, S (partial), E
  typeName: string;
  date?: string;
  notified?: string;
  amount: string;
  amountLow?: number;
  amountHigh?: number;
  description?: string;
  option?: { contracts: number; kind: string; strike: number; expires?: string; exercised: boolean };
  shares?: number;
  daysToDisclose?: number;
  late?: boolean;
}

export interface Ptr {
  docId: string;
  name: string;
  district: string;
  filed?: string;
  url: string;
  scanned: boolean; // a paper filing with no text layer: only the PDF can be read
  trades: Trade[];
}

/** '8/21/2026' → '2026-08-21' (two-digit years → 20xx). */
export function iso(mdy?: string): string | undefined {
  const m = (mdy ?? "").match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*$/);
  if (!m) return undefined;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  const d = new Date(Date.UTC(y, Number(m[1]) - 1, Number(m[2])));
  if (d.getUTCMonth() !== Number(m[1]) - 1) return undefined;
  return d.toISOString().slice(0, 10);
}

const tag = (block: string, name: string) => {
  const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? decodeXml(m[1].trim()) : "";
};
const decodeXml = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/** Every filing in a <YEAR>FD.xml, newest first. */
export function parseIndex(xml: string, year: number): IndexRow[] {
  const out: IndexRow[] = [];
  for (const m of xml.matchAll(/<Member>([\s\S]*?)<\/Member>/g)) {
    const b = m[1];
    const docId = tag(b, "DocID");
    const type = tag(b, "FilingType");
    const y = Number(tag(b, "Year")) || year;
    const name = [tag(b, "Prefix"), tag(b, "First"), tag(b, "Last"), tag(b, "Suffix")].filter(Boolean).join(" ");
    out.push({
      docId,
      type,
      last: tag(b, "Last"),
      first: tag(b, "First"),
      name,
      district: tag(b, "StateDst"),
      year: y,
      filed: iso(tag(b, "FilingDate")),
      url: type === "P" ? PTR_URL(y, docId) : `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${y}/${docId}.pdf`,
    });
  }
  return out.sort((a, b) => ((b.filed ?? "") + b.docId).localeCompare((a.filed ?? "") + a.docId));
}

/** 'pelosi', 'Nancy Pelosi' or 'Pelosi, Nancy' against an index row. */
export function memberMatch(row: Pick<IndexRow, "last" | "first">, member: string): boolean {
  const m = member.trim().toLowerCase();
  if (!m) return true;
  let last: string;
  let first: string;
  if (m.includes(",")) [last, first] = m.split(",", 2).map((x) => x.trim());
  else {
    const parts = m.split(/\s+/);
    last = parts[parts.length - 1];
    first = parts.slice(0, -1).join(" ");
  }
  if (row.last.toLowerCase() !== last) return false;
  return !first || row.first.toLowerCase().startsWith(first);
}

// ---------------------------------------------------------------- PTR text → trades

const TXN = /^\s*(?:(SP|JT|DC)\s+)?(.*?)\s+(S \(partial\)|P|S|E)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(\S.*?)\s*$/;
const LABELS: Array<[string, RegExp]> = [
  ["status", /^\s*F(?:ILING)?\s+S(?:TATUS)?\s*:\s*(.*)$/i],
  ["description", /^\s*D(?:ESCRIPTION)?\s*:\s*(.*)$/i],
  ["account", /^\s*S(?:UBHOLDING)?\s+O(?:F)?\s*:\s*(.*)$/i],
  ["location", /^\s*L(?:OCATION)?\s*:\s*(.*)$/i],
];
const PAGE_HEADER = /^\s*(ID\s+Owner\s+Asset|Type\s+Date\b|Type$|Date$|Gains >$|\$200\?$)/i;
const END = /^\s*(\* For the complete|I CERTIFY|Digitally Signed|Filing ID #)/i;
const OPTION = /([\d,]+)\s+(call|put)\s+options?\b.*?strike price of \$([\d,.]+).*?expiration date of (\d{1,2}\/\d{1,2}\/\d{2,4})/is;
const SHARES = /(?:purchased|sold|bought)\s+([\d,]+)\s+shares/i;
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Draft = Trade & { _asset: string };

function finish(row: Draft, filed?: string): Trade {
  const asset = row._asset.split(/\s+/).join(" ");
  const ticks = [...asset.matchAll(/\(([A-Z][A-Z0-9.\-/]{0,9})\)/g)].map((m) => m[1]);
  const codes = [...asset.matchAll(/\[([A-Z]{2})\]/g)].map((m) => m[1]);
  const ticker = ticks.at(-1);
  let name = asset.replace(/\s*\[[A-Z]{2}\]/g, "");
  if (ticker) name = name.replace(new RegExp(`\\s*\\(${escapeRx(ticker)}\\)`), "");
  const amount = row.amount.split(/\s+/).join(" ");
  const nums = [...amount.matchAll(/\$([\d,]+)/g)].map((m) => Number(m[1].replace(/,/g, "")));
  const description = row.description ? row.description.split(/\s+/).join(" ").trim() || undefined : undefined;
  const t: Trade = {
    owner: row.owner,
    ownerName: row.ownerName,
    asset: name.replace(/^[\s-]+|[\s-]+$/g, ""),
    ticker,
    assetType: codes.at(-1),
    type: row.type,
    typeName: row.typeName,
    date: row.date,
    notified: row.notified,
    amount,
    amountLow: nums[0],
    amountHigh: nums[1],
    description,
  };
  const opt = description?.match(OPTION);
  if (opt)
    t.option = { contracts: Number(opt[1].replace(/,/g, "")), kind: opt[2].toLowerCase(), strike: Number(opt[3].replace(/,/g, "")), expires: iso(opt[4]), exercised: /^\s*exercised\b/i.test(description!) };
  const sh = description?.match(SHARES);
  if (sh) t.shares = Number(sh[1].replace(/,/g, ""));
  if (filed && t.date) {
    t.daysToDisclose = Math.round((Date.parse(filed) - Date.parse(t.date)) / 86_400_000);
    t.late = t.daysToDisclose > LATE_DAYS;
  }
  return t;
}

/** Rows from the layout text of a House PTR (pdftotext -layout, or pdf.js lines rebuilt by layoutLines). */
export function parsePtrText(text: string, filed?: string): { name?: string; district?: string; docId?: string; filed?: string; trades: Trade[] } {
  const head: { name?: string; status?: string; district?: string; docId?: string; filed?: string } = { filed };
  const rows: Draft[] = [];
  let cur: Draft | undefined;
  let mode: "asset" | "description" | "labels" | undefined;
  let amountOpen = false;
  for (const raw of text.replace(/\u0000/g, "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    const s = line.trim();
    let m = s.match(/^Name:\s+(.*)$/);
    if (m && !head.name) {
      head.name = m[1].trim();
      continue;
    }
    m = s.match(/^Status:\s+(.*)$/);
    if (m && !head.status) {
      head.status = m[1].trim();
      continue;
    }
    m = s.match(/^State\/District:\s*(\S+)/);
    if (m) {
      head.district = m[1];
      continue;
    }
    m = s.match(/Filing ID #(\d+)/);
    if (m) {
      head.docId = m[1];
      continue;
    }
    m = s.match(/^Digitally Signed:.*?,\s*(\d{2}\/\d{2}\/\d{4})/);
    if (m) {
      head.filed = head.filed ?? iso(m[1]);
      continue;
    }
    const t = line.match(TXN);
    if (t && iso(t[4])) {
      if (cur) rows.push(cur);
      const owner = t[1] ?? "";
      cur = { owner, ownerName: OWNERS[owner] ?? owner, _asset: t[2], asset: "", type: t[3], typeName: TXN_TYPES[t[3]] ?? t[3], date: iso(t[4]), notified: iso(t[5]), amount: t[6] };
      amountOpen = cur.amount.endsWith("-");
      mode = "asset";
      continue;
    }
    if (!cur) continue;
    if (!s) {
      if (mode === "description" || mode === "asset") mode = mode === "description" || cur._asset.includes("[") ? "labels" : mode;
      continue;
    }
    if (PAGE_HEADER.test(s)) continue;
    if (END.test(s)) {
      mode = "labels";
      continue;
    }
    const label = LABELS.find(([, rx]) => rx.test(line));
    if (label) {
      const value = line.match(label[1])![1].trim();
      if (label[0] === "description") {
        cur.description = value;
        mode = "description";
      } else mode = "labels";
      continue;
    }
    if (mode === "asset") {
      const parts = s.split(/\s{2,}/);
      if (amountOpen && /^\$[\d,]+$/.test(parts[parts.length - 1])) {
        cur.amount += " " + parts.pop();
        amountOpen = false;
      }
      if (parts.length && parts[0]) cur._asset += " " + parts.join(" ");
    } else if (mode === "description") cur.description = (cur.description ?? "") + " " + s;
  }
  if (cur) rows.push(cur);
  return { ...head, trades: rows.map((r) => finish(r, head.filed)) };
}

/** pdf.js text items of one page → layout lines: same y = one line, a wide gap = 3 spaces (a column break). */
export function layoutLines(items: Array<{ str: string; x: number; y: number; width: number }>): string[] {
  const rows: Array<{ y: number; items: typeof items }> = [];
  for (const it of items.filter((i) => i.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x)) {
    const r = rows.find((row) => Math.abs(row.y - it.y) <= 2);
    if (r) r.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((r) => {
      const xs = r.items.sort((a, b) => a.x - b.x);
      let line = " ".repeat(Math.max(0, Math.round(xs[0].x / 6)));
      let end = xs[0].x;
      xs.forEach((it, i) => {
        if (i > 0) line += it.x - end > 6 ? "   " : it.x - end > 0.5 ? " " : "";
        line += it.str;
        end = it.x + it.width;
      });
      return line;
    });
}

/** What /api/congress returns. */
export interface CongressResult {
  asOf: string;
  today: string;
  days: number;
  members: string[];
  recent: Ptr[]; // every member's PTRs filed in the window
  tracked: Ptr[]; // the tracked members' PTRs this year
  recentFilings: number; // PTRs in the window (may exceed what was read)
  warnings: string[];
}

// ---------------------------------------------------------------- summaries for the card

export interface TradeRow extends Trade {
  member: string;
  district: string;
  docId: string;
  filed?: string;
  url: string;
}

export const flatten = (ptrs: Ptr[]): TradeRow[] =>
  ptrs.flatMap((p) => p.trades.map((t) => ({ ...t, member: p.name, district: p.district, docId: p.docId, filed: p.filed, url: p.url })));

export const isBuy = (t: Trade) => t.type === "P";
export const isSell = (t: Trade) => t.type.startsWith("S");

/** Tickers bought by the most different members (then most purchases). */
export function mostBought(rows: TradeRow[], top = 5): Array<{ ticker: string; members: number; buys: number; sells: number }> {
  const by = new Map<string, { members: Set<string>; buys: number; sells: number }>();
  for (const r of rows) {
    if (!r.ticker) continue;
    const e = by.get(r.ticker) ?? { members: new Set(), buys: 0, sells: 0 };
    if (isBuy(r)) {
      e.buys++;
      e.members.add(r.member);
    } else if (isSell(r)) e.sells++;
    by.set(r.ticker, e);
  }
  return [...by.entries()]
    .filter(([, e]) => e.buys > 0)
    .map(([ticker, e]) => ({ ticker, members: e.members.size, buys: e.buys, sells: e.sells }))
    .sort((a, b) => b.members - a.members || b.buys - a.buys)
    .slice(0, top);
}

export const amountLabel = (t: Trade) =>
  t.amountLow !== undefined && t.amountHigh !== undefined ? `$${short(t.amountLow)}–$${short(t.amountHigh)}` : t.amountLow !== undefined ? `$${short(t.amountLow)}+` : t.amount;
const short = (v: number) => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}K` : String(v));
