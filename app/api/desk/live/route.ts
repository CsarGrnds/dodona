import { NextResponse } from "next/server";
import { getLiveSession } from "@/lib/data/deskLive";

export const dynamic = "force-dynamic";

// GET /api/desk/live — Claude's current (or most recent) desk session, step by step, for live viewing.
export async function GET() {
  return NextResponse.json(getLiveSession(), { headers: { "Cache-Control": "no-store" } });
}
