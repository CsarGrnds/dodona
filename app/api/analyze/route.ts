import { NextResponse } from "next/server";
import type { PreviousCall } from "@/lib/agent";
import { analyze } from "@/lib/analyze";
import { normalizeSymbol } from "@/lib/data";
import type { Strategy } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/analyze  { symbol, strategy, previous?, useAgent? }
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { symbol: string; strategy?: Strategy; previous?: PreviousCall; useAgent?: boolean };
    const symbol = normalizeSymbol(body.symbol ?? "");
    const strategy: Strategy = body.strategy === "swing" ? "swing" : "dividend";
    const result = await analyze(symbol, strategy, { previous: body.previous, useAgent: body.useAgent });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
