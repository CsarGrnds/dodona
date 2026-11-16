import { NextResponse } from "next/server";
import { runChecks } from "@/lib/data/status";
import type { StatusResult } from "@/lib/status";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/status → a live health check of every connector (IBKR gateway, Yahoo, Google, SEC,
// House Clerk, Anthropic, local files). Read-only; caches are bypassed.
export async function GET() {
  const result: StatusResult = { asOf: new Date().toISOString(), checks: await runChecks() };
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
