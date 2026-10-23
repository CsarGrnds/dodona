"use client";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import PriceChart from "@/components/PriceChart";
import { Badge, Brand, Confidence, Disclaimer, Spinner, StrategyToggle } from "@/components/ui";
import { fmt, runAnalysis } from "@/lib/client";
import { getHistory, getSettings, getWatchlist, setWatchlist, type CallRecord } from "@/lib/store";
import type { Analysis, Strategy } from "@/lib/types";

export default function Page() {
  return (
    <Suspense fallback={<main className="shell"><Spinner /></main>}>
      <TickerPage />
    </Suspense>
  );
}

function TickerPage() {
  const params = useParams<{ symbol: string }>();
  const search = useSearchParams();
  const symbol = decodeURIComponent(params.symbol).toUpperCase();
  const [strategy, setStrategy] = useState<Strategy>((search.get("strategy") as Strategy) === "swing" ? "swing" : "dividend");
  const [a, setA] = useState<Analysis>();
  const [history, setHistory] = useState<CallRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { analysis } = await runAnalysis(symbol, strategy, getSettings().useAgent);
      setA(analysis);
      setHistory(getHistory(symbol));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [symbol, strategy]);

  useEffect(() => {
    setHistory(getHistory(symbol));
    run();
  }, [run, symbol]);

  const changeStrategy = (s: Strategy) => {
    setStrategy(s);
    const w = getWatchlist();
    if (w.some((i) => i.symbol === symbol)) setWatchlist(w.map((i) => (i.symbol === symbol ? { ...i, strategy: s } : i)));
  };

  const [following, setFollowing] = useState(false);
  useEffect(() => setFollowing(getWatchlist().some((i) => i.symbol === symbol)), [symbol]);
  const follow = () => {
    const w = getWatchlist();
    if (!w.some((i) => i.symbol === symbol)) setWatchlist([...w, { symbol, strategy, addedAt: new Date().toISOString() }]);
    setFollowing(true);
  };

  const q = a?.quote;
  const f = a?.fundamentals ?? {};
  const ind = a?.indicators ?? {};
  const callsForStrategy = history.filter((h) => h.strategy === strategy);

  return (
    <main className="shell">
      <div className="topbar">
        <Brand sub="ticker agent" />
        <div className="row">
          <StrategyToggle value={strategy} onChange={changeStrategy} />
          <button className="btn" onClick={follow} disabled={following}>{following ? "Following ✓" : "Follow"}</button>
          <button className="btn primary" onClick={run} disabled={busy}>{busy ? <Spinner /> : "Re-run agent"}</button>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 14, alignItems: "baseline" }}>
        <h2 className="mono" style={{ fontSize: 28, margin: 0 }}>{symbol}</h2>
        <span className="muted">{q?.name}</span>
        <span className="muted small">{q?.exchange} {f.sector ? `· ${f.sector}` : ""} {f.industry ? `· ${f.industry}` : ""}</span>
        <span className="spacer" />
        {q && (
          <>
            <span className="mono" style={{ fontSize: 24 }}>{fmt.money(q.price, q.currency)}</span>
            <span className={`mono ${q.change >= 0 ? "up" : "down"}`}>{fmt.signedPct(q.changePct)}</span>
          </>
        )}
      </div>

      {error && <div className="panel err" style={{ marginBottom: 14 }}>{error}</div>}
      {a?.warnings.map((w) => (
        <div key={w} className="warn" style={{ marginBottom: 8 }}>{w}</div>
      ))}

      {!a && busy && <div className="panel"><Spinner /> <span className="muted">Agent is reading {symbol}…</span></div>}

      {a && (
        <div className="grid" style={{ gap: 14 }}>
          <div className="grid two">
            <section className="panel">
              <h2>Price · 50d (gold) · 200d (blue) · past calls</h2>
              <PriceChart bars={a.bars} calls={callsForStrategy} levels={a.rules.levels} />
            </section>

            <section className="panel">
              <h2>Agent call · {strategy}</h2>
              <div className="row">
                <Badge action={a.final.action} big />
                <span className="spacer" />
                <span className="muted small">{a.final.source === "agent" ? a.agent?.model : "rule engine"} · {fmt.ago(a.generatedAt)}</span>
              </div>
              <div style={{ margin: "10px 0" }}>
                <Confidence value={a.final.confidence} />
                <span className="muted small">Confidence {(a.final.confidence * 100).toFixed(0)}%</span>
              </div>
              {a.agent ? (
                <>
                  <p className="thesis">{a.agent.thesis}</p>
                  {a.agent.risks.length > 0 && (
                    <>
                      <h2>Risks</h2>
                      <ul className="plain">{a.agent.risks.map((r) => <li key={r}>{r}</li>)}</ul>
                    </>
                  )}
                  {a.agent.watchFor.length > 0 && (
                    <>
                      <h2 style={{ marginTop: 12 }}>What would change the call</h2>
                      <ul className="plain">{a.agent.watchFor.map((r) => <li key={r}>{r}</li>)}</ul>
                    </>
                  )}
                </>
              ) : (
                <p className="muted small">{a.agentError ? `Agent error: ${a.agentError}. Showing rule-engine call.` : "Rule-engine call (Claude agent off or no API key)."}</p>
              )}
              {a.agent && a.agent.action !== a.rules.action && (
                <div className="warn" style={{ marginTop: 10 }}>Agent overrides the rule engine ({a.rules.action}, score {a.rules.score}).</div>
              )}
              <h2 style={{ marginTop: 14 }}>Levels</h2>
              <div className="kv">
                {a.rules.levels.buyBelow && <div><span>Buy below</span><span className="up">{fmt.money(a.rules.levels.buyBelow)}</span></div>}
                {a.rules.levels.trimAbove && <div><span>Trim above</span><span className="down">{fmt.money(a.rules.levels.trimAbove)}</span></div>}
                {a.rules.levels.stopLoss && <div><span>Stop</span><span className="down">{fmt.money(a.rules.levels.stopLoss)}</span></div>}
                {a.rules.levels.takeProfit && <div><span>Target</span><span className="up">{fmt.money(a.rules.levels.takeProfit)}</span></div>}
              </div>
            </section>
          </div>

          <div className="grid two">
            <section className="panel">
              <h2>Rule engine · score {a.rules.score} → {a.rules.action}</h2>
              <table>
                <thead><tr><th>Factor</th><th>Score</th><th>Evidence</th></tr></thead>
                <tbody>
                  {a.rules.factors.map((x) => (
                    <tr key={x.name}>
                      <td>{x.name}</td>
                      <td className={x.score > 0 ? "score-pos" : x.score < 0 ? "score-neg" : "score-zero"}>{x.score > 0 ? `+${x.score}` : x.score}</td>
                      <td className="muted">{x.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="panel">
              <h2>Call history ({callsForStrategy.length})</h2>
              <table>
                <thead><tr><th>When</th><th>Call</th><th>Price</th><th>Since</th></tr></thead>
                <tbody>
                  {[...callsForStrategy].reverse().slice(0, 12).map((h) => (
                    <tr key={h.generatedAt}>
                      <td className="small">{new Date(h.generatedAt).toLocaleString()}</td>
                      <td><Badge action={h.action} /></td>
                      <td className="mono">{fmt.num(h.price)}</td>
                      <td className={`mono ${q && q.price >= h.price ? "up" : "down"}`}>{q ? fmt.signedPct(q.price / h.price - 1) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          <section className="panel">
            <h2>Fundamentals</h2>
            <div className="kv">
              <div><span>Market cap</span><span>{fmt.big(f.marketCap)}</span></div>
              <div><span>Fwd P/E</span><span>{fmt.num(f.forwardPE, 1)}</span></div>
              <div><span>Trailing P/E</span><span>{fmt.num(f.trailingPE, 1)}</span></div>
              <div><span>PEG</span><span>{fmt.num(f.pegRatio)}</span></div>
              <div><span>Div yield</span><span>{fmt.pct(f.dividendYield, 2)}</span></div>
              <div><span>5y avg yield</span><span>{fmt.pct(f.fiveYearAvgDividendYield, 2)}</span></div>
              <div><span>Div rate</span><span>{fmt.money(f.dividendRate)}</span></div>
              <div><span>Payout</span><span>{fmt.pct(f.payoutRatio)}</span></div>
              <div><span>Ex-div</span><span>{f.exDividendDate ?? "—"}</span></div>
              <div><span>Rev growth</span><span>{fmt.pct(f.revenueGrowth)}</span></div>
              <div><span>EPS growth</span><span>{fmt.pct(f.earningsGrowth)}</span></div>
              <div><span>Margin</span><span>{fmt.pct(f.profitMargin)}</span></div>
              <div><span>Debt/Equity</span><span>{fmt.num(f.debtToEquity)}</span></div>
              <div><span>Beta</span><span>{fmt.num(f.beta)}</span></div>
              <div><span>Analyst target</span><span>{fmt.money(f.targetMeanPrice)}</span></div>
              <div><span>Consensus</span><span>{f.recommendationKey ?? "—"}</span></div>
            </div>
          </section>

          <section className="panel">
            <h2>Technicals</h2>
            <div className="kv">
              <div><span>RSI 14</span><span>{fmt.num(ind.rsi14, 1)}</span></div>
              <div><span>SMA 20</span><span>{fmt.num(ind.sma20)}</span></div>
              <div><span>SMA 50</span><span>{fmt.num(ind.sma50)}</span></div>
              <div><span>SMA 200</span><span>{fmt.num(ind.sma200)}</span></div>
              <div><span>MACD hist</span><span>{fmt.num(ind.macdHist, 3)}</span></div>
              <div><span>ATR 14</span><span>{fmt.num(ind.atr14)}</span></div>
              <div><span>52w high</span><span>{fmt.num(ind.high52w)}</span></div>
              <div><span>52w low</span><span>{fmt.num(ind.low52w)}</span></div>
              <div><span>From high</span><span>{fmt.pct(ind.drawdownFromHigh)}</span></div>
              <div><span>1m</span><span>{fmt.signedPct(ind.return1m)}</span></div>
              <div><span>3m</span><span>{fmt.signedPct(ind.return3m)}</span></div>
              <div><span>1y</span><span>{fmt.signedPct(ind.return1y)}</span></div>
            </div>
          </section>

          <section className="panel">
            <h2>News the agent read</h2>
            {a.news.length === 0 ? (
              <p className="muted small">No recent headlines.</p>
            ) : (
              <ul className="plain">
                {a.news.map((n) => (
                  <li key={n.link}>
                    <a href={n.link} target="_blank" rel="noreferrer">{n.title}</a>{" "}
                    <span className="muted small">{n.publisher} · {fmt.ago(n.publishedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
      <Disclaimer />
    </main>
  );
}
