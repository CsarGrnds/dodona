"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import CongressCard from "@/components/CongressCard";
import PortfolioPulse from "@/components/PortfolioPulse";
import SearchBox from "@/components/SearchBox";
import { Badge, Brand, Confidence, Disclaimer, Spinner, StrategyToggle } from "@/components/ui";
import { fmt, notifyChange, runAnalysis } from "@/lib/client";
import { getLastAnalysis, getSettings, getWatchlist, setSettings, setWatchlist, type Settings, type WatchItem } from "@/lib/store";
import type { Analysis, Strategy } from "@/lib/types";

type CardState = { analysis?: Analysis | null; busy?: boolean; error?: string; changed?: boolean };

export default function Dashboard() {
  const [watch, setWatch] = useState<WatchItem[]>([]);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [settings, setS] = useState<Settings | null>(null);
  const [lastSweep, setLastSweep] = useState<string>();
  const sweeping = useRef(false);

  // Hydrate from localStorage.
  useEffect(() => {
    const w = getWatchlist();
    setWatch(w);
    setS(getSettings());
    setCards(Object.fromEntries(w.map((i) => [i.symbol, { analysis: getLastAnalysis(i.symbol) }])));
  }, []);

  const saveWatch = (w: WatchItem[]) => {
    setWatch(w);
    setWatchlist(w);
  };
  const saveSettings = (s: Settings) => {
    setS(s);
    setSettings(s);
  };

  const analyzeOne = useCallback(
    async (item: WatchItem) => {
      setCards((c) => ({ ...c, [item.symbol]: { ...c[item.symbol], busy: true, error: undefined } }));
      try {
        const { analysis, previous } = await runAnalysis(item.symbol, item.strategy, settings?.useAgent ?? true);
        const changed = !!previous && previous.strategy === item.strategy && previous.action !== analysis.final.action;
        if (changed && settings?.notify) notifyChange(item.symbol, previous!.action, analysis.final.action, analysis.quote.price);
        setCards((c) => ({ ...c, [item.symbol]: { analysis, busy: false, changed } }));
      } catch (e) {
        setCards((c) => ({ ...c, [item.symbol]: { ...c[item.symbol], busy: false, error: e instanceof Error ? e.message : String(e) } }));
      }
    },
    [settings?.useAgent, settings?.notify],
  );

  const sweep = useCallback(async () => {
    if (sweeping.current) return;
    sweeping.current = true;
    for (const item of getWatchlist()) await analyzeOne(item); // sequential: gentle on rate limits
    setLastSweep(new Date().toISOString());
    sweeping.current = false;
  }, [analyzeOne]);

  // Auto-follow: re-run every agent on an interval while the tab is open.
  useEffect(() => {
    if (!settings?.autoFollow) return;
    sweep();
    const id = setInterval(sweep, Math.max(1, settings.intervalMin) * 60_000);
    return () => clearInterval(id);
  }, [settings?.autoFollow, settings?.intervalMin, sweep]);

  const add = (symbol: string) => {
    if (watch.some((w) => w.symbol === symbol)) return;
    const item: WatchItem = { symbol, strategy: "dividend", addedAt: new Date().toISOString() };
    saveWatch([...watch, item]);
    analyzeOne(item);
  };
  const remove = (symbol: string) => saveWatch(watch.filter((w) => w.symbol !== symbol));
  const setStrategy = (symbol: string, strategy: Strategy) => {
    const next = watch.map((w) => (w.symbol === symbol ? { ...w, strategy } : w));
    saveWatch(next);
    analyzeOne(next.find((w) => w.symbol === symbol)!);
  };

  const counts = watch.reduce(
    (acc, w) => {
      const a = cards[w.symbol]?.analysis?.final.action;
      if (a) acc[a]++;
      return acc;
    },
    { BUY: 0, SELL: 0, HOLD: 0 },
  );

  return (
    <main className="shell">
      <div className="topbar">
        <Brand />
        <div className="row">
          <Link className="btn ghost" href="/today">Today</Link>
          <Link className="btn ghost" href="/setups">Setups</Link>
          <Link className="btn ghost" href="/portfolio">Portfolio</Link>
          <Link className="btn ghost" href="/desk">Desk</Link>
          <Link className="btn ghost" href="/status">Status</Link>
          <SearchBox onPick={add} />
        </div>
      </div>

      <PortfolioPulse />

      <div className="panel row" style={{ marginBottom: 14 }}>
        <span className="muted small">Following {watch.length}</span>
        <Badge action="BUY" /> <span className="mono">{counts.BUY}</span>
        <Badge action="HOLD" /> <span className="mono">{counts.HOLD}</span>
        <Badge action="SELL" /> <span className="mono">{counts.SELL}</span>
        <span className="spacer" />
        {settings && (
          <>
            <label className="row small muted">
              <input type="checkbox" checked={settings.autoFollow} onChange={(e) => saveSettings({ ...settings, autoFollow: e.target.checked })} />
              Auto-follow every
              <select value={settings.intervalMin} onChange={(e) => saveSettings({ ...settings, intervalMin: Number(e.target.value) })} className="btn ghost" style={{ padding: "3px 6px" }}>
                {[5, 15, 30, 60].map((m) => (
                  <option key={m} value={m}>{m} min</option>
                ))}
              </select>
            </label>
            <label className="row small muted">
              <input type="checkbox" checked={settings.useAgent} onChange={(e) => saveSettings({ ...settings, useAgent: e.target.checked })} />
              Claude agent
            </label>
            <label className="row small muted">
              <input
                type="checkbox"
                checked={settings.notify}
                onChange={async (e) => {
                  const on = e.target.checked;
                  if (on && typeof Notification !== "undefined" && Notification.permission !== "granted") await Notification.requestPermission();
                  saveSettings({ ...settings, notify: on });
                }}
              />
              Alert on call change
            </label>
          </>
        )}
        <button className="btn primary" onClick={sweep} disabled={sweeping.current}>Run all agents</button>
        <span className="muted small">Last sweep {fmt.ago(lastSweep)}</span>
      </div>

      <section className="grid cards">
        {watch.map((w) => {
          const st = cards[w.symbol] ?? {};
          const a = st.analysis;
          const q = a?.quote;
          return (
            <article key={w.symbol} className={`panel card${st.changed ? " changed" : ""}`}>
              <div className="row">
                <Link href={`/ticker/${encodeURIComponent(w.symbol)}?strategy=${w.strategy}`}>
                  <div className="sym">{w.symbol}</div>
                  <div className="name">{q?.name ?? "—"}</div>
                </Link>
                <span className="spacer" />
                {st.busy ? <Spinner /> : a ? <Badge action={a.final.action} /> : null}
              </div>
              <div className="row">
                <span className="price">{q ? fmt.money(q.price, q.currency) : "—"}</span>
                {q && <span className={`mono ${q.change >= 0 ? "up" : "down"}`}>{fmt.signedPct(q.changePct)}</span>}
              </div>
              {a && (
                <>
                  <Confidence value={a.final.confidence} />
                  <div className="small muted" style={{ minHeight: 34 }}>
                    {a.agent?.thesis ? a.agent.thesis.slice(0, 140) + (a.agent.thesis.length > 140 ? "…" : "") : `Rule score ${a.rules.score} · ${a.rules.factors.filter((f) => f.score !== 0).length} active factors`}
                  </div>
                </>
              )}
              {st.changed && <div className="warn">Call changed since last run</div>}
              {st.error && <div className="err">{st.error}</div>}
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <StrategyToggle value={w.strategy} onChange={(s) => setStrategy(w.symbol, s)} />
                <span className="spacer" />
                <span className="muted small" style={{ whiteSpace: "nowrap" }}>{fmt.ago(a?.generatedAt)}</span>
                <button className="btn ghost small" onClick={() => analyzeOne(w)} disabled={st.busy} title="Re-run agent">↻</button>
                <button className="btn ghost small" onClick={() => remove(w.symbol)} title="Unfollow">✕</button>
              </div>
            </article>
          );
        })}
      </section>
      {watch.length === 0 && <p className="muted">Search for a ticker above to start following it.</p>}

      <div style={{ marginTop: 14 }}>
        <CongressCard />
      </div>
      <Disclaimer />
    </main>
  );
}
