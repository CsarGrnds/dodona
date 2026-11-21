"use client";
// Paper mode, in Settings: the one switch between practice (fake money) and real money. Turning it on
// is one click; turning it off asks you to type REAL MONEY. Only your click here changes it.
import { useState } from "react";

const CONFIRM = "REAL MONEY";

export function PaperSwitch({ paper, onChanged }: { paper: boolean; onChanged: (paper: boolean) => void }) {
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const send = async (next: boolean) => {
    setBusy(true);
    setErr(undefined);
    try {
      const r = await fetch("/api/settings/paper", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paper: next, typed }) });
      const j = await r.json();
      if (!j.ok) return setErr(j.error ?? `HTTP ${r.status}`);
      setAsking(false);
      setTyped("");
      onChanged(j.paper);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`paper-switch ${paper ? "on" : "off"}`}>
      <div className="row" style={{ gap: 10 }}>
        <span className={`pill ${paper ? "act" : "bad"}`}>{paper ? "Practice · fake money" : "Real money"}</span>
        <b>Paper mode</b>
        <span className="spacer" />
        {paper ? (
          !asking && <button className="btn ghost" onClick={() => setAsking(true)} disabled={busy}>Turn off · trade real money</button>
        ) : (
          <button className="btn" onClick={() => send(true)} disabled={busy}>Turn on · practice with fake money</button>
        )}
      </div>
      <div className="small muted">
        {paper
          ? "On: the Desk shows the $-ledger practice account with a PAPER DESK watermark, the team can run practice cycles (they use tokens), and IBKR orders may only go to a paper account (DU…)."
          : "Off: no practice anywhere. The Desk shows your real IBKR account, no tokens go to practice trades, and batches you approve go to your real IBKR account."}
      </div>
      {asking && (
        <div className="row" style={{ gap: 8 }}>
          <label className="small">
            Type <b className="mono">{CONFIRM}</b> to trade real money:{" "}
            <input className="mono" value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send(false)} autoFocus aria-label="Type REAL MONEY" />
          </label>
          <button className="btn danger" onClick={() => send(false)} disabled={busy || typed.trim().toUpperCase() !== CONFIRM}>Turn paper off</button>
          <button className="btn ghost" onClick={() => { setAsking(false); setTyped(""); }} disabled={busy}>Cancel</button>
        </div>
      )}
      {err && <div className="err small">{err}</div>}
    </div>
  );
}
