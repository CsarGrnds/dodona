import { NextResponse } from "next/server";
import { memberMatch, type CongressResult, type IndexRow, type Ptr } from "@/lib/congress";
import { houseIndex, readPtrs } from "@/lib/data/congress";
import { nyClock } from "@/lib/setups";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_RECENT = 80; // PDFs read for the "everyone, last N days" window

// GET /api/congress?days=30&member=pelosi[&member=...] → House PTRs, parsed (like /trader-pelosi).
export async function GET(req: Request) {
  const u = new URL(req.url).searchParams;
  const days = Math.min(90, Math.max(1, Number(u.get("days")) || 30));
  const members = u.getAll("member").map((m) => m.trim()).filter((m) => m && m.length <= 60).slice(0, 10);
  if (!members.length) members.push("pelosi");
  const today = nyClock(Date.now()).date;
  const year = Number(today.slice(0, 4));
  const since = new Date(Date.parse(`${today}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
  const warnings: string[] = [];

  let rows: IndexRow[] = [];
  for (const y of today.slice(5, 7) === "01" ? [year, year - 1] : [year]) {
    try {
      rows.push(...(await houseIndex(y)));
    } catch (e) {
      warnings.push(`House index ${y} unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  rows = rows.filter((r) => r.type === "P");
  const recentRows = rows.filter((r) => (r.filed ?? "") >= since);
  const trackedRows = rows.filter((r) => members.some((m) => memberMatch(r, m))).slice(0, 25);
  if (recentRows.length > MAX_RECENT) warnings.push(`${recentRows.length} reports in the last ${days} days; read the newest ${MAX_RECENT}.`);

  const toRead = new Map<string, IndexRow>();
  for (const r of [...trackedRows, ...recentRows.slice(0, MAX_RECENT)]) toRead.set(r.docId, r);
  const ptrs = await readPtrs([...toRead.values()], warnings);
  const byId = new Map(ptrs.map((p) => [p.docId, p]));
  const out: CongressResult = {
    asOf: new Date().toISOString(),
    today,
    days,
    members,
    recent: recentRows.slice(0, MAX_RECENT).map((r) => byId.get(r.docId)).filter((p): p is Ptr => !!p),
    tracked: trackedRows.map((r) => byId.get(r.docId)).filter((p): p is Ptr => !!p),
    recentFilings: recentRows.length,
    warnings,
  };
  return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
}
