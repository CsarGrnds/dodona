import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Board } from "@/lib/board";
import type { StrategyStats } from "@/lib/strategies";

export const dynamic = "force-dynamic";

const nyDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const read = (...p: string[]) => readFile(resolve(process.cwd(), "trader", ...p), "utf8").catch(() => "");

// GET /api/desk/board — the scout's board for today (every shortlisted stock's state and the team's
// call on it) and the strategist's latest research (the backtest table and its report).
export async function GET() {
  const date = nyDate();
  const boardText = await read("runs", `board-${date}.json`);
  const board = boardText ? (JSON.parse(boardText) as Board) : null;
  const latestText = await read("research", "latest.json");
  const latest = latestText ? (JSON.parse(latestText) as { ranAt: string; sessions: { from: string; to: string; count: number }; budget: number; strategies: StrategyStats[]; caveats?: string[] }) : null;
  const report = await read("research", "report.md");
  return NextResponse.json(
    { date, board, research: latest ? { ranAt: latest.ranAt, sessions: latest.sessions, budget: latest.budget, strategies: latest.strategies, caveats: latest.caveats ?? [], report: report || undefined } : null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
