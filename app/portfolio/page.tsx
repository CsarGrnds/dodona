"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import IbkrSync from "@/components/IbkrSync";
import { Badge, Brand, Disclaimer, Spinner } from "@/components/ui";
import { fetchPortfolio, fmt, runAnalysis } from "@/lib/client";
import { CONCENTRATION_WARN, holdings, syncAgeHours, type Portfolio } from "@/lib/portfolio";
import { getWatchlist, setWatchlist } from "@/lib/store";
import type { Analysis, Strategy } from "@/lib/types";

type Calls = { dividend?: Analysis; swing?: Analysis; busy?: boolean; error?: string };
const STRATS: Strategy[] = ["dividend", "swing"];
const PARALLEL = 3;

export default function PortfolioPage() {
  const [pf, setPf] = useState<Portfolio | null>();
  const [loadErr, setLoadErr] = useState<string>();
  const [calls, setCalls] = useState<Record<string, Calls>>({});
  const [running, setRunning] = useState(false);
  const [followed, setFollowed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoadErr(undefined);
    try {
      setPf(await fetchPortfolio(true));
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
      setPf(null);
    }
  }, []);

  useEffect(() => {
    load();
    setFollowed(new Set(getWatchlist().map((w) => w.symbol)));
  }, [load]);

  // Rules-only analysis for every holding, both strategies. The Claude agent runs on the ticker page.
  const analyzeAll = useCallback(async (p: Portfolio) => {
    setRunning(true);
    const queue = p.positions.map((x) => x.ticker);
    const worker = async () => {
      for (let sym = queue.shift(); sym; sym = queue.shift()) {
        setCalls((c) => ({ ...c, [sym]: { ...c[sym], busy: true, error: undefined } }));
        const next: Calls = {};
        for (const st of STRATS) {
          try {
            next[st] = (await runAnalysis(sym, st, false)).analysis;
          } catch (e) {
            next.error = e instanceof Error ? e.message : String(e);
          }
        }
        setCalls((c) => ({ ...c, [sym]: { ...next, busy: false } }));
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    setRunning(false);
  }, []);

  useEffect(() => {
    if (pf) analyzeAll(pf);
  }, [pf, analyzeAll]);

  const rows = useMemo(() => (pf ? holdings(pf) : []), [pf]);
  const totals = useMemo(() => {
    if (!pf) return undefined;
    const cost = pf.positions.reduce((s, p) => s + p.shares * p.avgCost, 0);
    const pnl = pf.positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const day = pf.positions.reduce((s, p) => s + (p.dailyPnl ?? 0), 0);
    return { cost, pnl, day, pnlPct: cost > 0 ? pnl / cost : 0, cashPct: pf.netLiquidation > 0 ? pf.cash / pf.netLiquidation : 0 };
  }, [pf]);
  const concentrated = rows.filter((r) => r.weight > CONCENTRATION_WARN);
  const counts = useMemo(() => {
    const c = { dividend: { BUY: 0, HOLD: 0, SELL: 0 }, swing: { BUY: 0, HOLD: 0, SELL: 0 } };
    for (const v of Object.values(calls)) for (const st of STRATS) if (v[st]) c[st][v[st]!.final.action]++;
    return c;
  }, [calls]);

  const strategyFor = (sym: string): Strategy => {
    const y = calls[sym]?.dividend?.fundamentals.dividendYield ?? 0;
    return y >= 0.015 ? "dividend" : "swing";
  };
  const followAll = () => {
    const w = getWatchlist();
    const have = new Set(w.map((i) => i.symbol));
    const now = new Date().toISOString();
    const added = rows.filter((r) => !have.has(r.ticker)).map((r) => ({ symbol: r.ticker, strategy: strategyFor(r.ticker), addedAt: now }));
    setWatchlist([...w, ...added]);
    setFollowed(new Set([...have, ...added.map((a) => a.symbol)]));
  };

  return (
    <main className="shell">
      <div className="topbar">
        <Brand sub="portfolio · interactive brokers" />
        <div className="row">
          <Link className="btn ghost" href="/">Watchlist</Link>
          <Link className="btn ghost" href="/today">Today</Link>
          <Link className="btn ghost" href="/setups">Setups</Link>
          <Link className="btn ghost" href="/desk">Desk</Link>
          <Link className="btn ghost" href="/status">Status</Link>
          {pf && (
            <>
              <button className="btn" onClick={followAll} disabled={rows.every((r) => followed.has(r.ticker))}>
                {rows.every((r) => followed.has(r.ticker)) ? "Following all ✓" : "Follow all"}
              </button>
              <button className="btn primary" onClick={() => analyzeAll(pf)} disabled={running}>{running ? <Spinner /> : "Re-analyze"}</button>
            </>
          )}
        </div>
      </div>

      {loadErr && <div className="panel err" style={{ marginBottom: 14 }}>{loadErr}</div>}
      {pf === undefined && <div className="panel"><Spinner /> <span className="muted">Loading portfolio…</span></div>}

      {pf === null && !loadErr && (
        <section className="panel">
          <h2>No portfolio synced yet</h2>
          <p className="small">Read your positions straight from Interactive Brokers through the IBKR Client Portal Gateway running on this machine (read-only):</p>
          <IbkrSync onSynced={setPf} primary label="Sync from IBKR" />
          <p className="small">Or, in a Claude Code session in this repo, say:</p>
          <pre className="mono small">sync my IBKR positions</pre>
          <p className="muted small">That runs the <span className="mono">/dodona-sync</span> skill: it reads your positions and account summary (read-only) and writes <span className="mono">trader/portfolio.json</span>, which stays on this machine (gitignored). Then reload this page.</p>
        </section>
      )}

      {pf && totals && (
        <div className="grid" style={{ gap: 14 }}>
          <section className="panel">
            <div className="kv">
              <div><span>Net liquidation</span><span>{fmt.money(pf.netLiquidation, pf.currency)}</span></div>
              <div><span>Invested</span><span>{fmt.money(pf.grossPositionValue, pf.currency)}</span></div>
              <div><span>Cash</span><span>{fmt.money(pf.cash, pf.currency)} ({fmt.pct(totals.cashPct)})</span></div>
              <div><span>Unrealized P&amp;L</span><span className={totals.pnl >= 0 ? "up" : "down"}>{fmt.money(totals.pnl, pf.currency)} ({fmt.signedPct(totals.pnlPct)})</span></div>
              <div><span>Day P&amp;L</span><span className={totals.day >= 0 ? "up" : "down"}>{fmt.money(totals.day, pf.currency)}</span></div>
              <div><span>Positions</span><span>{pf.positions.length}</span></div>
              <div>
                <span>Synced from IBKR</span>
                <span className={syncAgeHours(pf) > 24 ? "down" : ""}>{fmt.ago(pf.syncedAt)}</span>
              </div>
              {syncAgeHours(pf) <= 24 && (
                <div>
                  <span>Refresh</span>
                  <IbkrSync onSynced={setPf} label="IBKR" />
                </div>
              )}
            </div>
            {syncAgeHours(pf) > 24 && (
              <div className="warn" style={{ marginTop: 10 }}>
                Positions are over a day old. <IbkrSync onSynced={setPf} />
              </div>
            )}
          </section>

          {concentrated.length > 0 && (
            <div className="warn">
              Concentration: {concentrated.map((r) => `${r.ticker} is ${fmt.pct(r.weight)}`).join(", ")} of the account (above {fmt.pct(CONCENTRATION_WARN, 0)}).
            </div>
          )}

          <section className="panel">
            <div className="row" style={{ marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>Positions · rule-engine calls</h2>
              <span className="spacer" />
              {STRATS.map((st) => (
                <span key={st} className="muted small">
                  {st}: <span className="up">{counts[st].BUY} buy</span> · {counts[st].HOLD} hold · <span className="down">{counts[st].SELL} sell</span>
                </span>
              ))}
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th><th>Shares</th><th>Avg cost</th><th>Price</th><th>Value</th><th>Weight</th><th>P&amp;L</th><th>Dividend</th><th>Swing</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const c = calls[r.ticker] ?? {};
                    const strat = strategyFor(r.ticker);
                    return (
                      <tr key={r.ticker}>
                        <td>
                          <Link href={`/ticker/${encodeURIComponent(r.ticker)}?strategy=${strat}`} className="mono">{r.ticker}</Link>
                          <div className="muted small">{c.dividend?.quote.name ?? ""}</div>
                        </td>
                        <td className="mono">{+r.shares.toFixed(4)}</td>
                        <td className="mono">{fmt.num(r.avgCost)}</td>
                        <td className="mono">{fmt.num(r.marketPrice)}</td>
                        <td className="mono">{fmt.money(r.marketValue)}</td>
                        <td className="mono">
                          <span className={r.weight > CONCENTRATION_WARN ? "down" : ""}>{fmt.pct(r.weight)}</span>
                          <div className="weight-bar"><div style={{ width: `${Math.min(100, r.weight * 100 * 2)}%` }} /></div>
                        </td>
                        <td className={`mono ${r.unrealizedPnl >= 0 ? "up" : "down"}`}>
                          {fmt.money(r.unrealizedPnl)}
                          <div className="small">{fmt.signedPct(r.pnlPct)}</div>
                        </td>
                        {STRATS.map((st) => (
                          <td key={st} title={c[st] ? topFactors(c[st]!) : undefined}>
                            {c.busy && !c[st] ? <Spinner /> : c[st] ? (
                              <>
                                <Badge action={c[st]!.final.action} /> <span className="muted small mono">{c[st]!.rules.score}</span>
                              </>
                            ) : c.error ? <span className="err" title={c.error}>error</span> : "—"}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="muted small" style={{ marginBottom: 0 }}>
              Prices and P&amp;L are IBKR&apos;s as of the sync; calls use live Yahoo data and the rule engine only (hover a call for its top factors). Open a ticker for the Claude agent, factors and a trade plan sized to this account.
            </p>
          </section>
        </div>
      )}
      <Disclaimer />
    </main>
  );
}

function topFactors(a: Analysis): string {
  return a.rules.factors
    .filter((f) => f.score !== 0)
    .sort((x, y) => Math.abs(y.score) - Math.abs(x.score))
    .slice(0, 3)
    .map((f) => `${f.name} ${f.score > 0 ? "+" : ""}${f.score}: ${f.detail}`)
    .join("\n");
}
