"use client";
// A stop ticket on Today: raise the stop order protecting a holding at IBKR (or set one), shown as a
// plain ticket with every gate, and sent only on your click (with "STOP TSLA 352.10" typed unless
// One-click approval is on). IBKR's own questions come back here for you to answer.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Spinner } from "@/components/ui";
import type { PlaceResult, StopTicketView } from "@/lib/data/ibkrOrders";

export function StopTicket({ symbol, suggested, price, noLoss, onClose, onSent }: { symbol: string; suggested: number; price?: number; noLoss: boolean; onClose: () => void; onSent: () => void }) {
  const [to, setTo] = useState(suggested.toFixed(2));
  const [t, setT] = useState<StopTicketView>();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [questions, setQuestions] = useState<PlaceResult["questions"]>([]);
  const [sent, setSent] = useState(false);

  const load = useCallback(async (stop: string) => {
    setBusy("load");
    try {
      const q = new URLSearchParams({ symbol, to: stop, noLoss: noLoss ? "1" : "0", ...(price ? { price: String(price) } : {}) });
      const r = await fetch(`/api/ibkr/stop?${q}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) setMsg({ ok: false, text: j.error ?? `HTTP ${r.status}` });
      else setT(j);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(undefined);
    }
  }, [symbol, noLoss, price]);
  useEffect(() => {
    load(suggested.toFixed(2));
  }, [load, suggested]);

  const post = async (body: Record<string, unknown>, label: string) => {
    setBusy(label);
    setMsg(undefined);
    try {
      const r = await fetch("/api/ibkr/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (j.ok === false && !j.note) setMsg({ ok: false, text: j.error ?? j.errors?._ ?? `HTTP ${r.status}` });
      return j as PlaceResult;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(undefined);
    }
  };
  const after = (j?: PlaceResult) => {
    if (!j) return;
    setQuestions(j.questions ?? []);
    if (j.note) setMsg({ ok: j.ok && !!j.placed?.length, text: j.note });
    if (j.placed?.length) {
      setSent(true);
      onSent();
    }
  };
  const place = (oneClick: boolean) =>
    t?.change && post({ action: "place", symbol, to: t.change.to, noLoss, price, fingerprint: t.fingerprint, typed, oneClick }, "place").then(after);

  const live = t?.account ? !t.accountIsPaper : false;
  const dirty = t?.change ? Number(to) !== t.change.to : true;
  return (
    <div className="st-ticket">
      <div className="row" style={{ gap: 8 }}>
        <b>Stop ticket · {symbol}</b>
        {t?.account && <span className={`pill ${live ? "bad" : "act"}`}>{live ? "REAL money" : "Paper"} · …{t.account.slice(-3)}</span>}
        <span className="spacer" />
        <label className="row small" style={{ gap: 6 }}>
          New stop $
          <input className="st-to mono" value={to} inputMode="decimal" onChange={(e) => setTo(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load(to)} disabled={sent} aria-label="New stop price" />
        </label>
        {dirty && !sent && <button className="btn ghost" onClick={() => load(to)} disabled={!!busy}>Update ticket</button>}
        <button className="btn ghost" onClick={onClose} aria-label="Close the ticket">✕</button>
      </div>

      {busy === "load" && !t && <div className="muted small"><Spinner /> Reading the position and its stop at IBKR…</div>}
      {t && t.lines.length > 0 && <div className="ib-ticket">{t.lines.join("\n")}</div>}
      {t && t.problems.length > 0 && (
        <ul className="ib-problems small">
          {t.problems.map((p) => <li key={p}>{p}</li>)}
          {t.problems.some((p) => /Settings/.test(p)) && <li><Link href="/settings">Open Settings</Link></li>}
        </ul>
      )}

      {t?.ready && t.change && !dirty && !sent && questions.length === 0 && (
        <div className="ib-place">
          {t.oneClick ? (
            <button className={`btn ${live ? "danger" : "primary"}`} disabled={!!busy} onClick={() => place(true)} title="One-click approval is on (Settings → Broker). Every other gate still applies.">
              {busy === "place" ? <Spinner /> : `Send to IBKR: ${t.change.orderId ? "raise" : t.change.replaces ? `replace ${symbol} stop: ${t.change.qty} shares at` : "set"}${t.change.replaces ? "" : ` ${symbol} stop to`} $${t.change.to.toFixed(2)} ${live ? "(REAL money)" : "(paper)"}`}
            </button>
          ) : (
            <>
              <label className="small">
                Type <b className="mono">{t.confirm}</b> to confirm
                <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t.confirm} style={{ width: 190 }} />
              </label>
              <button className={`btn ${live ? "danger" : "primary"}`} disabled={!!busy || typed.trim().toUpperCase().replace(/\$/g, "").replace(/\s+/g, " ") !== t.confirm} onClick={() => place(false)}>
                {busy === "place" ? <Spinner /> : `Send to IBKR ${live ? "(REAL money)" : "(paper)"}`}
              </button>
            </>
          )}
        </div>
      )}

      {questions.map((q) => (
        <div key={q.id} className="ib-question small">
          <b>IBKR asks about {q.symbol}:</b>
          {q.messages.map((m, i) => <div key={i}>{m}</div>)}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn danger" disabled={!!busy} onClick={() => post({ action: "answer", id: q.id, confirmed: true }, "answer").then(after)}>Yes, send it</button>
            <button className="btn ghost" disabled={!!busy} onClick={() => post({ action: "answer", id: q.id, confirmed: false }, "answer").then(after)}>No</button>
          </div>
        </div>
      ))}
      {msg && <div className={`small ${msg.ok ? "up" : "caution"}`} style={{ marginTop: 8 }}>{msg.text}</div>}
    </div>
  );
}
