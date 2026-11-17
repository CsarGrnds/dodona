import { NextResponse } from "next/server";
import { localOnly } from "@/lib/data/localOnly";
import { listClaudeSessions, projectDir } from "@/lib/data/transcripts";

export const dynamic = "force-dynamic";

// GET /api/claude/sessions — this project's Claude Code sessions on this machine, newest first.
// Local only: read from ~/.claude/projects/<this project>/, never sent anywhere.
export async function GET(req: Request) {
  const denied = localOnly(req);
  if (denied) return denied;
  const sessions = await listClaudeSessions().catch(() => []);
  return NextResponse.json({ sessions, dir: projectDir() }, { headers: { "Cache-Control": "no-store" } });
}
