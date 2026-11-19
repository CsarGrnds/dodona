import { NextResponse } from "next/server";
import { answerQuestion, placeStopTicket, stopTicket } from "@/lib/data/ibkrOrders";
import { fromDodonaPage, localOnly } from "@/lib/data/localOnly";

export const dynamic = "force-dynamic";

// GET /api/ibkr/stop?symbol=TSLA&to=352.10&noLoss=1&price=360.20 — the stop ticket for one holding:
// raise its stop order at IBKR (or set one), with every gate it still has to pass. Read-only.
// POST {action:"place", symbol, to, noLoss, price, fingerprint, typed, oneClick} / {action:"answer", id,
// confirmed} — only from a click in Dodona's page. See lib/data/ibkrOrders.ts for every gate.
export async function GET(req: Request) {
  const denied = localOnly(req);
  if (denied) return denied;
  const q = new URL(req.url).searchParams;
  try {
    const { conid: _conid, ...t } = await stopTicket({ symbol: q.get("symbol") ?? "", to: Number(q.get("to")), noLoss: q.get("noLoss") !== "0", price: Number(q.get("price")) || undefined });
    void _conid;
    return NextResponse.json(t, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const denied = fromDodonaPage(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  try {
    if (b?.action === "place")
      return NextResponse.json(
        await placeStopTicket({ symbol: String(b.symbol ?? ""), to: Number(b.to), noLoss: b.noLoss !== false, price: Number(b.price) || undefined, fingerprint: String(b.fingerprint ?? ""), typed: String(b.typed ?? ""), oneClick: b.oneClick === true }),
      );
    if (b?.action === "answer") return NextResponse.json(await answerQuestion({ id: String(b.id ?? ""), confirmed: b.confirmed === true }));
    return NextResponse.json({ ok: false, error: "action: place or answer" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
