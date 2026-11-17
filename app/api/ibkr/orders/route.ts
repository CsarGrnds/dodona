import { NextResponse } from "next/server";
import { answerQuestion, ibkrActivity, ibkrTicket, placeTicket, previewTicket } from "@/lib/data/ibkrOrders";
import { fromDodonaPage, localOnly, localWrite } from "@/lib/data/localOnly";

export const dynamic = "force-dynamic";

// GET /api/ibkr/orders — the order waiting in trader/orders.json as an IBKR ticket, every gate it
// still has to pass, and today's IBKR orders, fills and log (read-only).
// POST {action:"preview"} — IBKR's what-if for it (places nothing).
// POST {action:"place", fingerprint, typed} / {action:"answer", id, confirmed} — only from a click
// in Dodona's page. See lib/data/ibkrOrders.ts for every gate.
export async function GET(req: Request) {
  const denied = localOnly(req);
  if (denied) return denied;
  const ticket = await ibkrTicket();
  const activity = ticket.gateway === "ready" ? await ibkrActivity().catch(() => undefined) : undefined;
  return NextResponse.json({ ticket, activity }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const body = (await req.clone().json().catch(() => null)) as { action?: string; fingerprint?: string; typed?: string; id?: string; confirmed?: boolean } | null;
  const action = body?.action;
  const denied = action === "preview" ? localWrite(req) : fromDodonaPage(req);
  if (denied) return denied;
  try {
    if (action === "preview") return NextResponse.json({ ok: true, preview: await previewTicket() });
    if (action === "place") return NextResponse.json(await placeTicket({ fingerprint: String(body?.fingerprint ?? ""), typed: String(body?.typed ?? "") }));
    if (action === "answer") return NextResponse.json(await answerQuestion({ id: String(body?.id ?? ""), confirmed: body?.confirmed === true }));
    return NextResponse.json({ ok: false, error: "action: preview, place or answer" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
