"use client";
// The IBKR order tickets on the Desk: the batch trader-risk passed (trader/orders.json), every gate it
// still has to pass, IBKR's what-if preview, and placing it on your typed confirmation and click.
// Buy-stop orders then wait at IBKR and only buy if their breakout triggers. IBKR's own questions come
// back here for you to answer. Nothing is sent any other way.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Spinner } from "@/components/ui";
import type { IbkrActivity, IbkrPreview, IbkrTicket, PlaceResult } from "@/lib/data/ibkrOrders";

const money = (n?: number) => (n === undefined || !Number.isFinite(n) ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const norm = (s: string) => s.trim().toUpperCase().replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ");

export function IbkrOrderPanel() {
  const [t, setT] = useState<IbkrTicket>();
  const [act, setAct] = useState<IbkrActivity>();
  const [preview, setPreview] = useState<IbkrPreview[]>();
  const [typed, setTyped] = useState("");
  const [questions, setQuestions] = useState<PlaceResult["questions"]>([]);
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
      if (j.ok === false && !j.note) setMsg({ ok: false, text: j.error ?? j.errors?._ ?? `HTTP ${r.status}` });
      return j;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(undefined);
    }
  };

  const afterPlace = (j: PlaceResult | undefined) => {
    if (!j) return;
    setQuestions(j.questions ?? []);
    if (j.note) setMsg({ ok: j.ok && !j.failed?.length, text: [j.note, ...(j.failed ?? []).map((f) => `${f.symbol}: ${f.error}`)].join(" ") });
    if (j.placed?.length) setTyped("");
    load();
  };

  if (!t) return null;
  const off = !t.enabled;
  const phraseOk = !!t.confirm && norm(typed) === t.confirm;
  const live = t.account && !t.accountIsPaper;

  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>⇄ IBKR orders</h2>
        <span className={`pill ${off ? "" : t.accountIsPaper ? "ok" : t.account ? "bad" : "care"}`}>
          {off ? "Off" : t.account ? `${t.accountIsPaper ? "Paper" : "LIVE"} · …${t.account.slice(-3)}` : t.gateway === "login" ? "Gateway: log in" : t.gateway === "down" ? "Gateway down" : "…"}
        </span>
        <span className="spacer" />
        <Link className="small" href="/settings">Settings</Link>
      </div>

      {off ? (
        <div className="small muted">
          Placing real orders from Dodona is off. When you&apos;re ready: in <Link href="/settings">Settings</Link>, set the broker to Interactive Brokers and turn on <b>Send orders to IBKR</b>. While Paper trading is on, orders only go to an IBKR <b>paper</b> account; for real money, set <code>&quot;paper&quot;: false</code> in <code>trader/config.json</code> yourself. Each morning the trade team stages the day&apos;s trades; you approve them here once, and they wait at IBKR.
        </div>
      ) : (
        <>
          {t.items.length > 0 ? (
            <div className="ib-batch">
              {t.items.map((it, i) => {
                const pv = preview?.find((p) => p.symbol === it.plan.symbol);
                return (
                  <div key={it.fingerprint} className="ib-ticket">
                    <div><b>{i + 1}. {it.lines[0]}</b></div>
                    {it.lines.slice(1).map((l) => <div key={l}>{l}</div>)}
                    {pv && (
                      <div className="muted">
                        IBKR preview: {pv.error ? <span className="err">{pv.error}</span> : <>cost {money(pv.cost)} + commission {money(pv.commission)} = {money(pv.total)}</>}
                        {pv.warn && <> · <span style={{ color: "#e8b84a" }}>{pv.warn}</span></>}
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="small">
                Together they risk <b>{money(t.totalMaxLoss)}</b>{t.dailyLimit ? <> of your {money(t.dailyLimit)} daily limit</> : null}, if every stop fills. Each one buys only if its price triggers today; unfilled orders end at the close.
              </div>
            </div>
          ) : (
            <div className="small muted" style={{ marginBottom: 8 }}>No orders waiting. The trade team&apos;s morning run (<code>/trade-desk live</code>) stages them after the opening range, around 9:50 AM New York time.</div>
          )}

          <ul className="ib-gates small">
            {[
              ["Turned on in Settings", t.enabled],
              [t.paperOnly ? "A paper account (DU…), since Paper trading is on" : "Paper trading is OFF: these are REAL orders", t.account ? (t.paperOnly ? !!t.accountIsPaper : true) : false],
              ["trader-risk passed these exact orders in the last 15 minutes", t.items.length > 0 && !t.problems.some((p) => /trader-risk|orders\.json|risk check|order than|twice|only buys|bracket order|supported/i.test(p))],
              ["None of them is a stock you already hold", t.items.length > 0 && !t.problems.some((p) => /already hold/.test(p))],
              ["Fees are at most 25% of each trade's risk", t.items.length > 0 && !t.problems.some((p) => /commissions/.test(p))],
              ["Together they fit your daily loss limit", t.items.length > 0 && !t.problems.some((p) => /daily limit/.test(p))],
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

          {t.items.length > 0 && t.account && (
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn" disabled={!!busy} onClick={async () => { const j = await post({ action: "preview" }, "preview"); if (j?.ok) setPreview(j.preview); }}>
                {busy === "preview" ? <Spinner /> : "Preview at IBKR"}
              </button>
              <span className="small muted">places nothing</span>
            </div>
          )}

          {t.ready && t.confirm && questions.length === 0 && (
            <div className="ib-place">
              <label className="small">
                To place {t.items.length > 1 ? `all ${t.items.length}` : "it"}, type <b className="mono">{t.confirm}</b>
                <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t.confirm} autoComplete="off" spellCheck={false} />
              </label>
              <button className={`btn ${live ? "danger" : "primary"}`} disabled={!phraseOk || !!busy} onClick={async () => afterPlace(await post({ action: "place", fingerprints: t.items.map((x) => x.fingerprint), typed }, "place"))}>
                {busy === "place" ? <Spinner /> : `Place on IBKR ${live ? "(REAL money)" : "paper"}`}
              </button>
            </div>
          )}

          {questions.map((q) => (
            <div key={q.id} className="ib-question">
              <div className="small"><b>IBKR asks about {q.symbol}:</b> {q.messages.join(" ")}</div>
              <div className="row">
                <button className="btn primary small" disabled={!!busy} onClick={async () => afterPlace(await post({ action: "answer", id: q.id, confirmed: true }, "answer"))}>Yes, place it</button>
                <button className="btn small" disabled={!!busy} onClick={async () => afterPlace(await post({ action: "answer", id: q.id, confirmed: false }, "answer"))}>No, skip {q.symbol}</button>
              </div>
            </div>
          ))}
        </>
      )}

      {msg && <div className={msg.ok ? "small" : "err"} style={{ marginTop: 8, color: msg.ok ? "var(--buy)" : undefined }}>{msg.text}</div>}

      {act && act.unfilledToday > 0 && (
        <div className="row" style={{ marginTop: 10 }}>
          <span className="small">{act.unfilledToday} of today&apos;s buy orders are still waiting at IBKR.</span>
          <button className="btn small" disabled={!!busy} onClick={async () => { const j = await post({ action: "cancel" }, "cancel"); if (j?.ok) setMsg({ ok: true, text: `Canceled: ${j.canceled.join(", ") || "none"}${j.failed.length ? `; failed: ${j.failed.join(", ")}` : ""}. Filled positions keep their stop and target.` }); load(); }}>
            {busy === "cancel" ? <Spinner /> : "Cancel unfilled"}
          </button>
        </div>
      )}

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
