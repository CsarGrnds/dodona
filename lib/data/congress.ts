// Server only: the House Clerk's PTR index and PDFs (public, no key), read like /trader-pelosi.
// Parsed reports are kept in trader/state/congress/<DocID>.json (gitignored): a filed PTR never
// changes, so each PDF is downloaded once. The index is re-read at most every 6 hours (the Clerk
// rebuilds it about once a day).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { cached } from "../cache";
import { layoutLines, parseIndex, parsePtrText, type IndexRow, type Ptr } from "../congress";

const UA = "Dodona/0.1 (personal investment dashboard; reads public House PTRs)";
const STATE_DIR = () => path.join(process.cwd(), "trader", "state", "congress");

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The first .xml file inside a ZIP (stored or deflated), read from the central directory. */
export function unzipXml(zip: Buffer): string {
  if (zip[0] !== 0x50 || zip[1] !== 0x4b) return zip.toString("utf8");
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("index ZIP: no end of central directory");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
    if (name.toLowerCase().endsWith(".xml")) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return (method === 0 ? data : inflateRawSync(data)).toString("utf8");
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("index ZIP: no XML inside");
}

/** Every filing of a year, newest first. */
export function houseIndex(year: number): Promise<IndexRow[]> {
  return cached(`house:index:${year}`, 6 * 60 * 60_000, async () => parseIndex(unzipXml(await download(`https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`)), year));
}

async function pdfLines(pdf: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: true }).promise;
  const lines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    const items = (tc.items as Array<{ str?: string; transform?: number[]; width?: number }>)
      .filter((i) => typeof i.str === "string" && i.transform)
      .map((i) => ({ str: i.str!, x: i.transform![4], y: i.transform![5], width: i.width ?? 0 }));
    lines.push(...layoutLines(items), "");
  }
  await doc.cleanup?.();
  return lines.join("\n");
}

/** One PTR, parsed (from the disk cache when it was read before). */
export async function readPtr(row: IndexRow): Promise<Ptr> {
  const file = path.join(STATE_DIR(), `${row.docId}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8")) as Ptr;
  } catch {
    /* not cached yet */
  }
  const text = await pdfLines(await download(row.url));
  const parsed = parsePtrText(text, row.filed);
  const ptr: Ptr = { docId: row.docId, name: parsed.name ?? row.name, district: row.district, filed: row.filed ?? parsed.filed, url: row.url, scanned: text.replace(/\s/g, "").length < 80, trades: parsed.trades };
  await mkdir(STATE_DIR(), { recursive: true });
  await writeFile(file, JSON.stringify(ptr));
  return ptr;
}

/** Read many PTRs, a few at a time, so the Clerk's site isn't hammered. */
export async function readPtrs(rows: IndexRow[], warnings: string[], parallel = 4): Promise<Ptr[]> {
  const out: Ptr[] = [];
  const queue = [...rows];
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      try {
        out.push(await readPtr(r));
      } catch (e) {
        warnings.push(`${r.name} PTR ${r.docId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return out.sort((a, b) => ((b.filed ?? "") + b.docId).localeCompare((a.filed ?? "") + a.docId));
}
