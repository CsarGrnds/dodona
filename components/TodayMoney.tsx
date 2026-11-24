"use client";
// "Money for trading today": one number. Saving it turns on "Limits from the budget", so the max loss
// per trade, the daily loss limit, the biggest order and the share prices the shortlist allows all
// follow it (lib/budget.ts). Every other rule and every safety gate stays as it is.
import Link from "next/link";
import { useEffect, useState } from "react";
import { limitsFromBudget } from "@/lib/budget";
import { Spinner } from "./ui";

type Rules = Record<string, unknown>;
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

export function TodayMoney({ onSaved }: { onSaved?: () => void }) {
  const [rules, setRules] = useState<Rules>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [err, setErr] = useState<string>();

  const adopt = (r: Rules) => {
    setRules(r);
    setText(String(r.budget ?? ""));
  };
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((x) => (x.ok ? x.json() : null))
      .then((j) => j && adopt(j.rules))
      .catch(() => undefined);
  }, []);
  if (!rules) return null;

  const amount = Number(text.replace(/[$,\s]/g, ""));
  const valid = Number.isFinite(amount) && amount >= 1;
  const next = valid ? { ...rules, budget: amount, auto_from_budget: true } : rules;
  const lim = limitsFromBudget(next);
  const buffer = Number(rules.cash_buffer_pct ?? 10);
  const perTrade = Math.min((Number(next.budget) * (100 - buffer)) / 100, (Number(next.budget) * Number(rules.max_position_pct ?? 75)) / 100);
  const changed = !rules.auto_from_budget || (valid && amount !== Number(rules.budget));

  const save = async () => {
    if (!valid) return;
    setBusy(true);
    setErr(undefined);
    setMsg(undefined);
    try {
      const r = await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rules: { budget: amount, auto_from_budget: true } }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(Object.values(j.errors ?? {}).join(" ") || `HTTP ${r.status}`);
      adopt(j.settings.rules);
      setMsg("Saved");
      onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel tm">
      <span className="tm-label">Trading today</span>
      <span className="st-input">
        <span className="muted">$</span>
        <input value={text} inputMode="decimal" aria-label="Money for trading today" onChange={(e) => { setText(e.target.value); setMsg(undefined); }} onKeyDown={(e) => e.key === "Enter" && changed && save()} />
      </span>
      <button className="btn primary" disabled={!valid || !changed || busy} onClick={save}>
        {busy ? <Spinner /> : changed ? "Set" : "Set ✓"}
      </button>
      {valid && (
        <Link
          href="/settings"
          className="small muted tm-out"
          title={`Up to ${usd(Math.round(perTrade * 100) / 100)} in one trade, ${usd(Math.round(Number(next.budget) * buffer) / 100)} stays in cash. ${Number(rules.risk_pct ?? 2)}% may be lost on one trade, ${Number(rules.daily_loss_pct ?? 5)}% in a day (Settings).`}
        >
          max loss {usd(lim.max_loss_per_trade_usd)} a trade · {usd(lim.max_daily_loss_usd)} a day
        </Link>
      )}
      {msg && <span className="small" style={{ color: "var(--buy)" }}>{msg}</span>}
      {err && <span className="small err">{err}</span>}
    </section>
  );
}
