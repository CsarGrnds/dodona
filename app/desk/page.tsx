"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DailyPnlChart, EquityChart, PnlCalendar, RDistribution, signedUsd } from "@/components/DeskCharts";
import { Brand, Spinner } from "@/components/ui";
import { fmt } from "@/lib/client";
import type { DeskView } from "@/lib/data/deskView";
import type { JournalKind } from "@/lib/desk";
import type { RunReport } from "@/lib/data/deskRun";
import { getWatchlist } from "@/lib/store";

const AUTO_KEY = "dodona.desk.auto.v1";
const AUTO_MS = 5 * 60_000;
const KIND: Record<JournalKind, { icon: string; cls: string; label: string }> = {
  buy: { icon: "▲", cls: "ok", label: "Buy" },
  sell: { icon: "▼", cls: "act", label: "Sell" },
  skip: { icon: "○", cls: "", label: "Skip" },
  blocked: { icon: "⛔", cls: "bad", label: "Blocked" },
  "stop-raised": { icon: "⛨", cls: "act", label: "Stop" },
  hold: { icon: "◆", cls: "", label: "Hold" },
  note: { icon: "·", cls: "", label: "Note" },
};
const REASON: Record<string, string> = { target: "Target", stop: "Stop", "flat-by": "Flat by", time: "Time stop", agent: "Claude closed" };
const usd = (v?: number) => (v === undefined ? "—" : `$${v.toFixed(2)}`);
const tone = (v: number) => (v > 0 ? "up" : v < 0 ? "down" : "muted");
const nyTime = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const nyDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export default function DeskPage() {
  const [d, setD] = useState<DeskView>();
  const [report, setReport] = useState<RunReport>();
  const [err, setErr] = useState<string>();
  const [running, setRunning] = useState(false);
  const [auto, setAuto] = useState(false);
  const [chart, setChart] = useState<"equity" | "daily">("equity");
  const [feed, setFeed] = useState<"all" | "trades" | "claude">("all");
  const [, tick] = useState(0);
  const runningRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/desk", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setD(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setErr(undefined);
    try {
      const r = await fetch("/api/desk/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: getWatchlist().map((w) => w.symbol) }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setD(j.desk);
      setReport(j.report);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    load();
    try {
      setAuto(localStorage.getItem(AUTO_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, [load]);

  // auto: a desk cycle every 5 minutes while this page is open
  useEffect(() => {
    if (!auto) return;
    run();
    const id = setInterval(run, AUTO_MS);
    return () => clearInterval(id);
  }, [auto, run]);
  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const toggleAuto = () => {
    const v = !auto;
    setAuto(v);
    try {
      localStorage.setItem(AUTO_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const reset = async () => {
    if (!d) return;
    if (!window.confirm(`Start a fresh paper account with $${d.rules.budget}? The current ledger is saved as a backup file in trader/.`)) return;
    const r = await fetch("/api/desk/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
    const j = await r.json();
    if (r.ok) {
      setD(j.desk);
      setReport(undefined);
    } else setErr(j.error);
  };

  const journal = useMemo(() => {
    const j = d?.journal ?? [];
    if (feed === "trades") return j.filter((e) => e.kind === "buy" || e.kind === "sell");
    if (feed === "claude") return j.filter((e) => e.by === "claude");
    return j;
  }, [d, feed]);

  if (!d)
    return (
      <main className="shell">
        <div className="topbar"><Brand sub="agentic trading desk" /></div>
        {err ? <div className="err">{err}</div> : <div className="muted"><Spinner /> Opening the desk…</div>}
      </main>
    );

  const st = d.stats;
  const today = st.today;
  const nextRunIn = auto && d.lastRunAt ? Math.max(0, Date.parse(d.lastRunAt) + AUTO_MS - Date.now()) : undefined;

  return (
    <main className="shell">
      <div className="topbar">
        <Brand sub="agentic trading desk" />
        <div className="row" style={{ gap: 8 }}>
          <Link className="btn ghost" href="/">Watchlist</Link>
          <Link className="btn ghost" href="/today">Today</Link>
          <Link className="btn ghost" href="/setups">Setups</Link>
          <Link className="btn ghost" href="/portfolio">Portfolio</Link>
          <Link className="btn ghost" href="/status">Status</Link>
        </div>
      </div>

      {/* ---- hero */}
      <section className={`panel dk-hero ${today ? (today.pnl >= 0 ? "green" : "red") : ""}`}>
        <div className="dk-hero-main">
          <div className="row" style={{ gap: 8 }}>
            <span className="pill act">PAPER</span>
            <span className={`pill ${d.agent.enabled ? "ok" : "care"}`}>{d.agent.enabled ? `✦ Claude trading · ${d.agent.model}` : "Rules engine trading"}</span>
            <span className={`pill ${d.market.open ? "ok" : ""}`}>{d.market.open ? "Market open" : `Market closed · ${d.market.reason}`}</span>
          </div>
          <div className="dk-today">
            <div>
              <div className="muted small">Today</div>
              <div className={`dk-big mono ${tone(today?.pnl ?? 0)}`}>{signedUsd(today?.pnl ?? 0)}</div>
              <div className={`small mono ${tone(today?.pnl ?? 0)}`}>{fmt.signedPct(today?.pnlPct ?? 0)}{today ? ` · ${today.closed} closed, ${today.wins} won` : " · no trades yet today"}</div>
            </div>
            <div>
              <div className="muted small">Account value</div>
              <div className="dk-big mono">{usd(st.equity)}</div>
              <div className={`small mono ${tone(st.totalPnl)}`}>{signedUsd(st.totalPnl)} ({fmt.signedPct(st.totalPct)}) since {nyDate(d.startedAt)}</div>
            </div>
            <div>
              <div className="muted small">Cash · at risk</div>
              <div className="dk-mid mono">{usd(d.cash)}</div>
              <div className="small mono muted">{usd(d.positions.reduce((a, p) => a + p.risk, 0))} at the stops</div>
            </div>
          </div>
        </div>
        <div className="dk-hero-side">
          <button className="btn primary" onClick={run} disabled={running}>{running ? <><Spinner /> Running desk…</> : "Run desk now"}</button>
          <label className="dk-auto">
            <input type="checkbox" checked={auto} onChange={toggleAuto} /> Auto every 5 min
          </label>
          <div className="muted small">
            Last run {fmt.ago(d.lastRunAt)}
            {nextRunIn !== undefined && !running ? ` · next in ${Math.ceil(nextRunIn / 60_000)}m` : ""}
          </div>
        </div>
      </section>

      {!d.agent.enabled && (
        <div className="dk-banner">
          <b>Claude isn&apos;t connected yet</b>, so the rules engine is trading: it takes a setup only when that setup made money on that stock before. Add <code>ANTHROPIC_API_KEY</code> to <code>.env.local</code> and restart Dodona to let Claude read the charts and trade. Model: <code>{d.agent.model}</code> (change with <code>DODONA_DESK_MODEL</code>).
        </div>
      )}
      {err && <div className="err" style={{ marginTop: 12 }}>{err}</div>}

      {/* ---- stat tiles */}
      <section className="dk-tiles">
        <Tile label="Win rate" value={st.trades ? `${Math.round(st.winRate * 100)}%` : "—"} sub={`${st.trades} closed trade${st.trades === 1 ? "" : "s"}`} />
        <Tile label="Profit factor" value={st.profitFactor !== undefined ? st.profitFactor.toFixed(2) : "—"} sub="won ÷ lost, over 1 = profitable" cls={st.profitFactor === undefined ? "" : st.profitFactor >= 1 ? "up" : "down"} />
        <Tile label="Per trade" value={st.trades ? signedUsd(st.expectancy) : "—"} sub={st.trades ? `${st.avgR >= 0 ? "+" : ""}${st.avgR}R average` : "expectancy"} cls={tone(st.expectancy)} />
        <Tile label="Avg win · loss" value={st.trades ? `${st.avgWin ? usd(st.avgWin) : "—"} · ${st.avgLoss ? usd(Math.abs(st.avgLoss)) : "—"}` : "—"} sub="after fees" />
        <Tile label="Green · red days" value={`${st.greenDays} · ${st.redDays}`} sub={st.bestDay ? `best ${signedUsd(st.bestDay.pnl)}${st.worstDay ? `, worst ${signedUsd(st.worstDay.pnl)}` : ""}` : "no days yet"} />
        <Tile label="Max drawdown" value={fmt.pct(st.maxDrawdown, 1)} sub="peak to low, end of day" cls={st.maxDrawdown < -0.1 ? "down" : ""} />
        <Tile label="Streak" value={st.streak.kind === "none" ? "—" : `${st.streak.n} ${st.streak.kind === "win" ? "win" : "loss"}${st.streak.n === 1 ? "" : st.streak.kind === "win" ? "s" : "es"}`} sub={`fees ${usd(st.fees)}`} cls={st.streak.kind === "win" ? "up" : st.streak.kind === "loss" ? "down" : ""} />
      </section>

      {/* ---- charts */}
      <section className="grid two" style={{ marginTop: 14 }}>
        <div className="panel">
          <div className="row" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>{chart === "equity" ? "Account value" : "Profit and loss by day"}</h2>
            <span className="spacer" />
            <div className="seg">
              <button className={chart === "equity" ? "on" : ""} onClick={() => setChart("equity")}>Equity</button>
              <button className={chart === "daily" ? "on" : ""} onClick={() => setChart("daily")}>Daily P&amp;L</button>
            </div>
          </div>
          {chart === "equity" ? <EquityChart days={d.days} startCash={d.startCash} startDate={d.startedAt.slice(0, 10)} /> : <DailyPnlChart days={d.days} />}
        </div>
        <div className="panel">
          <h2>Calendar</h2>
          <PnlCalendar days={d.days} />
          <h2 style={{ marginTop: 16 }}>How trades ended</h2>
          <RDistribution rs={d.trades.map((t) => t.R)} />
        </div>
      </section>

      {/* ---- Claude's read + positions */}
      <section className="panel" style={{ marginTop: 14 }}>
        <div className="row">
          <h2 style={{ margin: 0 }}>Open positions</h2>
          <span className="spacer" />
          <span className="muted small">{d.positions.length} open</span>
        </div>
        {d.lastSummary && (
          <div className="dk-read">
            <span className="dk-read-icon">✦</span>
            <div>
              <div className="small muted">Claude&apos;s read · {fmt.ago(d.lastAgentAt)}</div>
              {d.lastSummary}
            </div>
          </div>
        )}
        {d.positions.length === 0 ? (
          <div className="dk-empty">Flat: no open positions. {d.market.open ? "The desk is watching for setups." : "The desk looks for entries while the market is open."}</div>
        ) : (
          <div className="dk-positions">
            {d.positions.map((p) => {
              const span = p.target - p.stop;
              const at = span > 0 ? Math.min(100, Math.max(0, ((p.lastPrice - p.stop) / span) * 100)) : 0;
              const ent = span > 0 ? ((p.entry - p.stop) / span) * 100 : 0;
              return (
                <div key={p.id} className="dk-pos">
                  <div className="row">
                    <Link href={`/ticker/${encodeURIComponent(p.symbol)}`} className="dk-sym">{p.symbol}</Link>
                    <span className="pill">{p.style === "day" ? "Day" : "Swing"}</span>
                    <span className="muted small">{p.setup} · {p.by === "claude" ? "✦ Claude" : "Rules"}</span>
                    <span className="spacer" />
                    <span className={`mono ${tone(p.unrealized)}`}>{signedUsd(p.unrealized)} <span className="small">({fmt.signedPct(p.unrealizedPct)})</span></span>
                  </div>
                  <div className="dk-track" title={`stop ${usd(p.stop)} → target ${usd(p.target)}`}>
                    <div className="dk-track-fill" style={{ width: `${at}%` }} />
                    <i className="dk-track-entry" style={{ left: `${ent}%` }} />
                  </div>
                  <div className="row small mono muted">
                    <span>stop {usd(p.stop)}{p.stop > p.initialStop ? " ↑" : ""}</span>
                    <span>{p.qty} @ {usd(p.entry)} → {usd(p.lastPrice)}</span>
                    <span className="spacer" />
                    <span>target {usd(p.target)}</span>
                  </div>
                  <div className="small dk-thesis">{p.thesis}</div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ---- last run */}
      {report && (
        <section className="panel" style={{ marginTop: 14 }}>
          <h2>Last run · {nyTime(report.at)}</h2>
          <div className="small">
            Scanned {report.scanned} stocks, {report.candidates.length} setup{report.candidates.length === 1 ? "" : "s"} found, {report.entries} bought, {report.exits} sold.
            {report.tooPricey.length > 0 && <span className="muted"> Too pricey for whole shares in this account: {report.tooPricey.join(", ")}.</span>}
          </div>
          {report.notes.map((n) => <div key={n} className="small muted">{n}</div>)}
          {report.candidates.length > 0 && (
            <div className="table-scroll" style={{ marginTop: 8 }}>
              <table>
                <thead><tr><th>Stock</th><th>Setup</th><th>Price</th><th>Track record here</th></tr></thead>
                <tbody>
                  {report.candidates.map((c) => (
                    <tr key={c.key}>
                      <td><b>{c.symbol}</b></td>
                      <td>{c.setup} <span className="muted small">({c.style})</span></td>
                      <td className="mono">{usd(c.price)}</td>
                      <td className="small">{c.record?.verdict ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ---- journal + trades */}
      <section className="grid two" style={{ marginTop: 14 }}>
        <div className="panel">
          <div className="row" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Desk journal</h2>
            <span className="spacer" />
            <div className="seg">
              <button className={feed === "all" ? "on" : ""} onClick={() => setFeed("all")}>All</button>
              <button className={feed === "trades" ? "on" : ""} onClick={() => setFeed("trades")}>Trades</button>
              <button className={feed === "claude" ? "on" : ""} onClick={() => setFeed("claude")}>Claude</button>
            </div>
          </div>
          {journal.length === 0 ? (
            <div className="dk-empty">Nothing yet. Every buy, sell, skip and blocked trade lands here with the reason.</div>
          ) : (
            <ol className="dk-feed">
              {journal.map((e, i) => (
                <li key={`${e.at}-${i}`}>
                  <span className={`dk-feed-icon ${KIND[e.kind].cls}`}>{KIND[e.kind].icon}</span>
                  <div>
                    <div className="small muted">{nyDate(e.at)} {nyTime(e.at)} · {e.by === "claude" ? "✦ Claude" : e.by === "rules" ? "Rules" : "Desk"}</div>
                    <div className="small">{e.text}</div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="panel">
          <h2>By setup</h2>
          {st.bySetup.length === 0 ? (
            <div className="dk-empty">Shows which setups make money once trades close.</div>
          ) : (
            <div className="dk-setups">
              {st.bySetup.map((x) => (
                <div key={x.setup} className="row small">
                  <span>{x.setup}</span>
                  <span className="spacer" />
                  <span className="muted">{x.trades} · {Math.round(x.winRate * 100)}% · {x.avgR >= 0 ? "+" : ""}{x.avgR}R</span>
                  <b className={`mono ${tone(x.pnl)}`}>{signedUsd(x.pnl)}</b>
                </div>
              ))}
            </div>
          )}
          <h2 style={{ marginTop: 16 }}>Who traded</h2>
          <div className="dk-setups">
            {(["claude", "rules"] as const).map((k) => (
              <div key={k} className="row small">
                <span>{k === "claude" ? "✦ Claude" : "Rules engine"}</span>
                <span className="spacer" />
                <span className="muted">{st.byAgent[k].trades} trades</span>
                <b className={`mono ${tone(st.byAgent[k].pnl)}`}>{signedUsd(st.byAgent[k].pnl)}</b>
              </div>
            ))}
          </div>
          <h2 style={{ marginTop: 16 }}>Rules (trader/config.json)</h2>
          <div className="small dk-rules">
            <span>Budget <b>${d.rules.budget}</b></span>
            <span>Cash kept <b>{d.rules.cash_buffer_pct}%</b></span>
            <span>Max loss/trade <b>${d.rules.max_loss_per_trade_usd}</b></span>
            <span>Daily loss limit <b>${d.rules.max_daily_loss_usd}</b></span>
            <span>Trades/day <b>{d.rules.max_trades_per_day}</b></span>
            <span>Reward:risk ≥ <b>{d.rules.min_reward_risk}</b></span>
            <span>Entries <b>{d.rules.no_entries_before}–{d.rules.no_entries_after}</b></span>
            <span>Flat by <b>{d.rules.flat_by}</b></span>
            <span>Stops <b>{d.rules.require_stop ? "required" : "optional"}</b></span>
          </div>
          {!d.rulesFromFile && <div className="small warn" style={{ marginTop: 6 }}>trader/config.json not found: using the example rules. Say “set my rules” to make your own.</div>}
          <button className="btn" style={{ marginTop: 12 }} onClick={reset}>Reset paper account</button>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 14 }}>
        <h2>Trade history</h2>
        {d.trades.length === 0 ? (
          <div className="dk-empty">No closed trades yet.</div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Closed</th><th>Stock</th><th>Setup</th><th>By</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Why out</th><th>P&amp;L</th><th>R</th></tr>
              </thead>
              <tbody>
                {d.trades.map((t) => (
                  <tr key={t.id} title={`${t.thesis}\n\nExit: ${t.exitNote}`}>
                    <td className="small">{nyDate(t.exitAt)} {nyTime(t.exitAt)}</td>
                    <td><b>{t.symbol}</b></td>
                    <td className="small">{t.setup} <span className="muted">({t.style})</span></td>
                    <td className="small">{t.by === "claude" ? "✦ Claude" : "Rules"}</td>
                    <td className="mono">{t.qty}</td>
                    <td className="mono">{usd(t.entry)}</td>
                    <td className="mono">{usd(t.exit)}</td>
                    <td className="small">{REASON[t.reason] ?? t.reason}</td>
                    <td className={`mono ${tone(t.pnl)}`}>{signedUsd(t.pnl)}</td>
                    <td className={`mono ${tone(t.R)}`}>{t.R >= 0 ? "+" : ""}{t.R}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="disclaimer">
        Paper trading only: the desk never sends an order to a broker. Fills are simulated from Yahoo&apos;s delayed 5-minute bars with 0.05% slippage and a $0.35 commission each way; a real stop can fill worse in a fast market. Past paper results don&apos;t promise future ones. Not financial advice.
      </p>
    </main>
  );
}

function Tile({ label, value, sub, cls = "" }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="dk-tile">
      <div className="muted small">{label}</div>
      <div className={`dk-tile-v mono ${cls}`}>{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}
