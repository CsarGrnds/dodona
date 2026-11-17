import { NextResponse } from "next/server";
import { readDesk } from "@/lib/data/desk";
import { readTeamTranscript, teamModels } from "@/lib/data/transcripts";

export const dynamic = "force-dynamic";

// GET /api/desk/team[?session=T-…] — everything the Claude Code trade team did in one /trade-desk
// session (the latest when no id is given): the lead's steps, each subagent's skill runs and
// reports, read from this machine's Claude Code transcripts. Local and read-only.
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("session");
  const s = await readDesk().catch(() => null);
  const sess = (s?.sessions ?? []).find((x) => x.model === "Claude Code trade team" && (!id || x.id === id));
  if (!sess) return NextResponse.json({ error: "No trade team session yet. Run /trade-desk in Claude Code." }, { status: 404 });
  const models = await teamModels().catch(() => ({}));
  try {
    const transcript = await readTeamTranscript(sess.startedAt, sess.status === "running" ? undefined : sess.endedAt);
    return NextResponse.json({ session: sess, transcript, models }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ session: sess, models, transcript: { steps: [], agents: [], note: e instanceof Error ? e.message : String(e) } });
  }
}
