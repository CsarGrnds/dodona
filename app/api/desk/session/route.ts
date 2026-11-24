import { NextResponse } from "next/server";
import { localOnly } from "@/lib/data/localOnly";
import { latestSession } from "@/lib/data/session";

export const dynamic = "force-dynamic";

// GET /api/desk/session — the latest trading session in facts: the shortlist, every stock the team
// looked at and its decision, the coach's grades and the real IBKR orders that day. Read-only.
export async function GET(req: Request) {
  const denied = localOnly(req);
  if (denied) return denied;
  return NextResponse.json((await latestSession()) ?? null, { headers: { "Cache-Control": "no-store" } });
}
