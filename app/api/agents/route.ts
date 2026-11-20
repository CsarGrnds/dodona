import { NextResponse } from "next/server";
import { listProfiles, saveProfile } from "@/lib/data/agentProfiles";
import { localOnly, localWrite } from "@/lib/data/localOnly";

export const dynamic = "force-dynamic";

// GET /api/agents — every trade team profile (.claude/agents/trade-*.md, and the lead's skill read-only).
// POST {agent, text, base} — save one agent's profile. Only from a click in Dodona's own page on this
// computer; checked by lib/agentProfile.ts (name, model, tools, the "NEVER AN ORDER" rule).
export async function GET(req: Request) {
  const denied = localOnly(req);
  if (denied) return denied;
  return NextResponse.json({ profiles: await listProfiles() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const denied = localWrite(req);
  if (denied) return denied;
  if (!(req.headers.get("origin") && req.headers.get("sec-fetch-site") === "same-origin"))
    return NextResponse.json({ ok: false, errors: ["Agent profiles can only be saved by clicking Save in Dodona's own page."] }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { agent?: unknown; text?: unknown; base?: unknown } | null;
  if (typeof body?.agent !== "string" || typeof body.text !== "string" || typeof body.base !== "string")
    return NextResponse.json({ ok: false, errors: ["send agent, text and base"] }, { status: 400 });
  const r = await saveProfile(body.agent, body.text, body.base);
  return NextResponse.json(r, { status: r.ok ? 200 : r.conflict ? 409 : 400 });
}
