import { NextResponse } from "next/server";
import { localOnly, localWrite } from "@/lib/data/localOnly";
import { readSettings, saveSettings, type SettingsPatch } from "@/lib/data/settings";

export const dynamic = "force-dynamic";

// GET /api/settings — the trading rules (trader/config.json), the safety switches (shown, never
// changed here), each trade subagent's model and the desk's driver.
// POST /api/settings {rules?, models?, driver?} — validate everything first, then save. Localhost only.
export async function GET(req: Request) {
  const denied = localOnly(req);
  if (denied) return denied;
  return NextResponse.json(await readSettings(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const denied = localWrite(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as SettingsPatch | null;
  if (!body || typeof body !== "object") return NextResponse.json({ ok: false, errors: { _: "Send JSON." } }, { status: 400 });
  try {
    const r = await saveSettings(body);
    if (!r.ok) return NextResponse.json(r, { status: 422 });
    return NextResponse.json({ ...r, settings: await readSettings() });
  } catch (e) {
    return NextResponse.json({ ok: false, errors: { _: e instanceof Error ? e.message : String(e) } }, { status: 500 });
  }
}
