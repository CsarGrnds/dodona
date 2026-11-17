import { NextResponse } from "next/server";
import { localOnly } from "@/lib/data/localOnly";
import { isSessionId, readClaudeSession } from "@/lib/data/transcripts";

export const dynamic = "force-dynamic";

// GET /api/claude/sessions/<id> — everything one Claude Code session did: reasoning, commands, skills,
// each subagent's work, models, tokens and estimated cost. Local only.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = localOnly(req);
  if (denied) return denied;
  const { id } = await params;
  if (!isSessionId(id)) return NextResponse.json({ error: "Not a session id." }, { status: 400 });
  try {
    return NextResponse.json({ transcript: await readClaudeSession(id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
