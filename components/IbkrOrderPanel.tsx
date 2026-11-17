"use client";
// The IBKR order ticket on the Desk: the one bracket trader-risk passed (trader/orders.json), every
// gate it still has to pass, IBKR's what-if preview, and placing it on your typed confirmation and
// click. IBKR's own questions come back here for you to answer. Nothing is sent any other way.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Spinner } from "@/components/ui";
import type { IbkrActivity, IbkrPreview, IbkrTicket } from "@/lib/data/ibkrOrders";

type Question = { id: string; messages: string[] };

const money = (n?: number) => (n === undefined || !Number.isFinite(n) ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

export function IbkrOrderPanel() {
  const [t, setT] = useState<IbkrTicket>();
  const [act, setAct] = useState<IbkrActivity>();
  const [preview, setPreview] = useState<IbkrPreview>();
  const [typed, setTyped] = useState("");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/ibkr/orders", { cache: "no-store" });
      const j = await r.json();
      if (r.ok) {
        setT(j.ticket);
        setAct(j.activity);
      }
    } catch {
      /* keep the last view */
    }
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
  }, [load]);

  const post = async (body: Record<string, unknown>, label: string) => {
    setBusy(label);
    setMsg(undefined);
    try {
      const r = await fetch("/api/ibkr/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!j.ok) setMsg({ ok: false, text: j.error ?? j.errors?._ ?? `HTTP ${r.status}` });
      return j;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(undefined);
    }
  };

  const afterPlace = (j: { ok?: boolean; placed?: unknown[]; questions?: Question[]; note?: string } | undefined) => {
    if (!j?.ok) return;
    setQuestions(j.questions ?? []);
    if (j.note) setMsg({ ok: true, text: j.note });
    if (j.placed?.length) setTyped("");
    load();
  };

  if (!t) return null;
  const off = !t.enabled;
  const phraseOk = !!t.confirm && typed.trim().replace(/\s+/g, " ").toUpperCase() === t.confirm;

  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>⇄ IBKR order</h2>
        <span className={`pill ${off ? "" : t.accountIsPaper ? "ok" : t.account ? "bad" : "care"}`}>
          {off ? "Off" : t.account ? `${t.accountIsPaper ? "Paper" : "LIVE"} · ${t.account}` : t.gateway === "login" ? "Gateway: log in" : t.gateway === "down" ? "Gateway down" : "…"}
        </span>
        <span className="spacer" />
        <Link className="small" href="/settings">Settings</Link>
      </div>

      {off ? (
        <div className="small muted">
          Placing real orders from Dodona is off. When you&apos;re ready: in <Link href="/settings">Settings</Link>, set the broker to Interactive Brokers and turn on <b>Send orders to IBKR</b>. While Paper trading is on, orders only go to your IBKR <b>paper</b> account (log in to the gateway with it). The order comes from <code>/trader-budget</code> → <code>/trader-risk</code>, and only you place it, here.
        </div>
      ) : (
        <>
          {t.lines ? (
            <pre className="ib-ticket">{t.lines.join("\n")}</pre>
          ) : (
            <div className="small muted" style={{ marginBottom: 8 }}>No order waiting. Run <code>/trader-budget</code> and <code>/trader-risk</code> in Claude Code (from the repo root, the real-account pipeline).</div>
          )}

          <ul className="ib-gates small">
            {[
              ["Turned on in Settings", t.enabled],
              [t.paperOnly ? "A paper account (DU…), since Paper trading is on" : "Paper trading is OFF: this would be a LIVE order", t.account ? (t.paperOnly ? !!t.accountIsPaper : true) : false],
              ["trader-risk passed this exact order in the last 15 minutes", !!t.fingerprint && !t.problems.some((p) => /risk|order/i.test(p))],
              ["The market is open", !t.problems.some((p) => /market is closed/.test(p))],
            ].map(([label, ok]) => (
              <li key={String(label)} className={ok ? "ok" : "no"}>{ok ? "✓" : "✕"} {label}</li>
            ))}
          </ul>
          {t.problems.length > 0 && (
            <ul className="small ib-problems">
              {t.problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}

          {t.plan && t.account && (
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn" disabled={!!busy} onClick={async () => { const j = await post({ action: "preview" }, "preview"); if (j?.ok) setPreview(j.preview); }}>
                {busy === "preview" ? <Spinner /> : "Preview at IBKR"}
              </button>
              {preview && (
                <span className="small muted">
                  {preview.error ? <span className="err">{preview.error}</span> : <>Cost {money(preview.cost)} + commission {money(preview.commission)} = {money(preview.total)}{preview.equityAfter ? ` · equity after ${preview.equityAfter}` : ""}</>}
                  {preview.warn && <> · <span style={{ color: "#e8b84a" }}>{preview.warn}</span></>}
                  <span> (nothing placed)</span>
                </span>
              )}
            </div>
          )}

          {t.ready && t.confirm && questions.length === 0 && (
            <div className="ib-place">
              <label className="small">
                To place it, type <b className="mono">{t.confirm}</b>
                <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t.confirm} autoComplete="off" spellCheck={false} />
              </label>
              <button className={`btn ${t.accountIsPaper ? "primary" : "danger"}`} disabled={!phraseOk || !!busy} onClick={async () => afterPlace(await post({ action: "place", fingerprint: t.fingerprint, typed }, "place"))}>
                {busy === "place" ? <Spinner /> : `Place on IBKR ${t.accountIsPaper ? "paper" : "LIVE"}`}
              </button>
            </div>
          )}

          {questions.map((q) => (
            <div key={q.id} className="ib-question">
              <div className="small"><b>IBKR asks:</b> {q.messages.join(" ")}</div>
              <div className="row">
                <button className="btn primary small" disabled={!!busy} onClick={async () => afterPlace(await post({ action: "answer", id: q.id, confirmed: true }, "answer"))}>Yes, place it</button>
                <button className="btn small" disabled={!!busy} onClick={async () => afterPlace(await post({ action: "answer", id: q.id, confirmed: false }, "answer"))}>No, cancel</button>
              </div>
            </div>
          ))}
        </>
      )}

      {msg && <div className={msg.ok ? "small" : "err"} style={{ marginTop: 8, color: msg.ok ? "var(--buy)" : undefined }}>{msg.text}</div>}

      {act && (act.log.length > 0 || act.open.length > 0 || act.trades.length > 0) && (
        <div className="ib-activity small">
          {act.log.length > 0 && (
            <div>
              <b>Today in the log</b>
              {act.log.map((r, i) => <div key={i} className="muted">{r.at.slice(11, 16)} · {r.status} · {r.side} {r.qty ?? ""} {r.symbol}{r.broker_order_id ? ` · #${r.broker_order_id}` : ""}{r.note ? ` · ${r.note}` : ""}</div>)}
            </div>
          )}
          {act.open.length > 0 && (
            <div>
              <b>Working at IBKR</b>
              {act.open.map((o) => <div key={o.orderId} className="muted">{o.side} {o.qty} {o.ticker} · {o.desc} · {o.status}</div>)}
            </div>
          )}
          {act.trades.length > 0 && (
            <div>
              <b>Fills</b>
              {act.trades.map((x) => <div key={x.id} className="muted">{x.side} {x.qty} {x.symbol} @ {money(x.price)}{x.commission !== undefined ? ` · fee ${money(x.commission)}` : ""}</div>)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
