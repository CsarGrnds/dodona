"use client";
// Main screen: today's winners and losers in your IBKR holdings, and why the portfolio is up or down.
import Link from "next/link";
import { useEffect, useState } from "react";
import AccountChart from "@/components/AccountChart";
import { Spinner } from "@/components/ui";
import { fmt } from "@/lib/client";
import type { MarketStatus } from "@/lib/clock";
import type { Mover, Pulse } from "@/lib/pulse";

type Res = { asOf: string; clock: MarketStatus; syncedAt: string; currency: string; pulse: Pulse; warnings: string[] } | { portfolio: null; warnings: string[] };

const signed = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;

export default function PortfolioPulse() {
  const [d, setD] = useState<Res>();
  const [err, setErr] = useState<string>();
  const [view, setView] = useState<"day" | "total">("day");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const r = await fetch("/api/pulse", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setD(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    load();
  }, []);

  if (err) return <section className="panel err" style={{ marginBottom: 14 }}>Portfolio pulse: {err}</section>;
  if (!d) return <section className="panel" style={{ marginBottom: 14 }}><Spinner /> <span className="muted">Reading your holdings at live prices…</span></section>;
  if (!("pulse" in d)) {
    return (
      <section className="panel small" style={{ marginBottom: 14 }}>
        No IBKR portfolio synced yet: <Link href="/portfolio" className="up">sync it on the Portfolio page</Link> to see your winners, losers and why.
      </section>
    );
  }

  const p = d.pulse;
  const session = d.clock.open ? "Today" : `Last session`;
  const head = view === "day" ? p.day : p.total;
  const win = view === "day" ? p.winners : p.totalWinners;
  const lose = view === "day" ? p.losers : p.totalLosers;
  const why = view === "day" ? p.why : p.whyTotal;

  return (
    <section className="panel pulse" style={{ marginBottom: 14 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Your portfolio</h2>
        <div className="seg">
          <button className={view === "day" ? "on" : ""} onClick={() => setView("day")}>{session}</button>
          <button className={view === "total" ? "on" : ""} onClick={() => setView("total")}>Since you bought</button>
        </div>
        <span className="spacer" />
        <span className={`pulse-head mono ${head.pnl >= 0 ? "up" : "down"}`}>
          {signed(head.pnl)} <span className="small">({fmt.signedPct(head.pct)})</span>
        </span>
        <button className="btn small ghost" onClick={load} disabled={busy} title="Refresh prices">{busy ? <Spinner /> : "↻"}</button>
      </div>

      <AccountChart />

      <div className="pulse-cols">
        <MoverList title="Top winners" items={win} kind="up" />
        <MoverList title="Top losers" items={lose} kind="down" />
        <div>
          <div className="check-group">Why</div>
          <ul className="reasons small">{why.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      </div>
      <p className="muted small" style={{ marginBottom: 0 }}>
        Your IBKR shares (synced {fmt.ago(d.syncedAt)}) at Yahoo prices{d.clock.open ? "" : ", last session vs the close before it"}. “Market” is SPY × each stock&apos;s beta; a headline is a lead, not proof of the cause.{" "}
        <Link href="/today" className="up">Today&apos;s prep →</Link> <Link href="/portfolio" className="up">Portfolio →</Link>
      </p>
      {d.warnings.length > 0 && <div className="warn" style={{ marginTop: 8 }}>{d.warnings.join(" · ")}</div>}
    </section>
  );
}

function MoverList({ title, items, kind }: { title: string; items: Mover[]; kind: "up" | "down" }) {
  const max = Math.max(...items.map((m) => Math.abs(m.pnl)), 1e-9);
  return (
    <div>
      <div className="check-group">{title}</div>
      {items.length === 0 ? (
        <div className="muted small">None</div>
      ) : (
        items.map((m) => (
          <div key={m.ticker} className="mover" title={m.headline ? `${m.headline.title}${m.headline.publisher ? ` — ${m.headline.publisher}` : ""}` : m.name}>
            <Link href={`/ticker/${encodeURIComponent(m.ticker)}`} className="mono">{m.ticker}</Link>
            <span className={`mono ${kind}`}>{signed(m.pnl)}</span>
            <span className={`mono small ${kind}`}>{fmt.signedPct(m.pct)}</span>
            <div className={`mover-bar ${kind}`}><i style={{ width: `${(Math.abs(m.pnl) / max) * 100}%` }} /></div>
          </div>
        ))
      )}
    </div>
  );
}
