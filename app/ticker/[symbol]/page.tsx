"use client";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import PriceChart, { type ChartLine } from "@/components/PriceChart";
import type { SetupsResult } from "@/components/SetupBits";
import { ChartAnalysis, Checklist, EarningsPanel, MarketClock, NewsPanel, SetupsPanel, TimeMachinePanel } from "@/components/TickerPanels";
import TradePlan from "@/components/TradePlan";
import { Badge, Brand, Confidence, Disclaimer, Spinner, StrategyToggle } from "@/components/ui";
import { DEFAULT_SWING_PARAMS } from "@/lib/backtest";
import { buildChecklist } from "@/lib/checklist";
import { fetchPortfolio, fmt, runAnalysis } from "@/lib/client";
import { marketStatus } from "@/lib/clock";
import { MIN_TOUCHES, type Level } from "@/lib/levels";
import type { ResearchResult } from "@/lib/news";
import { buildTradePlan, DEFAULT_PLAN_SETTINGS, type AccountContext, type PlanSettings } from "@/lib/plan";
import { findHolding, type Portfolio } from "@/lib/portfolio";
import { getHistory, getSettings, getWatchlist, setWatchlist, type CallRecord } from "@/lib/store";
import { dailyPool, simulate } from "@/lib/timemachine";
import type { Analysis, Strategy } from "@/lib/types";

const HOLD_DAYS = DEFAULT_SWING_PARAMS.maxHoldDays;

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

  // Everything else Dodona knows about this stock, loaded alongside the agent call.
  const [settings, setSettings] = useState<PlanSettings>();
  const [pf, setPf] = useState<Portfolio | null>(null);
  const [setups, setSetups] = useState<{ data?: SetupsResult; error?: string }>({});
  const [research, setResearch] = useState<ResearchResult>();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    fetchPortfolio().then(setPf).catch(() => setPf(null));
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    setResearch(undefined);
    fetch(`/api/research?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setResearch(d as ResearchResult))
      .catch((e) => setResearch({ symbol, sec: "error", filings: [], earnings: null, warnings: [String(e)] }));
  }, [symbol]);
  const stopAtr = settings?.stopAtr;
  const targetR = settings?.targetR;
  useEffect(() => {
    if (stopAtr === undefined || targetR === undefined) return;
    let live = true;
    setSetups({});
    fetch(`/api/setups?symbol=${encodeURIComponent(symbol)}&stopAtr=${stopAtr}&targetR=${targetR}&maxHold=${HOLD_DAYS}`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? `Setups failed (${r.status})`);
        if (live) setSetups({ data: d as SetupsResult });
      })
      .catch((e) => live && setSetups({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [symbol, stopAtr, targetR]);

  const status = useMemo(() => marketStatus(now), [now]);
  const holding = findHolding(pf, symbol);
  // The long plan at today's price, built even when the call isn't BUY, so the levels, the
  // Time Machine and the risk check answer "what if I bought here?".
  const longPlan = useMemo(() => {
    if (!a) return undefined;
    const acct: AccountContext | undefined = pf ? { netLiquidation: pf.netLiquidation, cash: pf.cash, heldValue: holding ? holding.shares * a.quote.price : 0, heldShares: holding?.shares } : undefined;
    return buildTradePlan({ symbol, action: "BUY", price: a.quote.price, atr14: a.indicators.atr14 }, settings ?? DEFAULT_PLAN_SETTINGS, acct);
  }, [a, settings, pf, holding, symbol]);
  const tm = useMemo(() => {
    if (!a || !longPlan || longPlan.entry === undefined || longPlan.stop === undefined || longPlan.target === undefined) return null;
    return simulate(dailyPool(a.bars), { entry: longPlan.entry, stop: longPlan.stop, target: longPlan.target }, HOLD_DAYS);
  }, [a, longPlan]);
  const checks = useMemo(() => {
    if (!a) return [];
    return buildChecklist({
      today: status.date,
      quote: a.quote,
      indicators: a.indicators,
      market: a.market,
      relativeStrength: a.relativeStrength,
      levels: a.chartLevels,
      swing: setups.data?.swing ?? undefined,
      plan: longPlan,
      timeMachine: tm,
      nextEarningsDate: a.fundamentals.nextEarningsDate,
      earningsEstimated: a.fundamentals.earningsDateEstimated,
      holdDays: HOLD_DAYS,
      news: a.news,
      filings: research ? (research.sec === "no-user-agent" ? null : research.filings) : undefined,
    });
  }, [a, setups.data, longPlan, tm, research, status.date]);
  const loading = [!setups.data && !setups.error && "setups", !research && "SEC filings"].filter(Boolean) as string[];
  const lines = useMemo<ChartLine[]>(() => {
    const out: ChartLine[] = [];
    const strong = (l: Level) => l.touches >= MIN_TOUCHES;
    for (const l of (a?.chartLevels?.supports ?? []).filter(strong).slice(0, 2)) out.push({ price: l.price, color: "#2fbf71", title: `S ${l.touches}×`, dashed: true });
    for (const l of (a?.chartLevels?.resistances ?? []).filter(strong).slice(0, 2)) out.push({ price: l.price, color: "#e5534b", title: `R ${l.touches}×`, dashed: true });
    if (longPlan?.stop !== undefined) out.push({ price: longPlan.stop, color: "#e5534b", title: "Plan stop" });
    if (longPlan?.target !== undefined) out.push({ price: longPlan.target, color: "#2fbf71", title: "Plan target" });
    return out;
  }, [a, longPlan]);

  const q = a?.quote;
  const f = a?.fundamentals ?? {};
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
        <MarketClock st={status} />
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
              <h2>Price · 50d (gold) · 200d (blue) · support / resistance (dashed) · plan stop / target</h2>
              <PriceChart bars={a.bars} calls={callsForStrategy} levels={strategy === "dividend" ? a.rules.levels : undefined} lines={lines} />
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

          <Checklist checks={checks} loading={loading} />

          <div className="grid two">
            <SetupsPanel d={setups.data} error={setups.error} />
            <ChartAnalysis levels={a.chartLevels} ind={a.indicators} price={a.quote.price} />
          </div>

          <div className="grid halves">
            <TradePlan analysis={a} onSettings={setSettings} />
            <TimeMachinePanel tm={tm} hypothetical={a.final.action !== "BUY"} />
          </div>

          <div className="grid halves">
            <NewsPanel news={a.news} filings={research?.filings} sec={research?.sec} changePct={a.quote.changePct} />
            <section className="panel">
              <h2>Rule engine · score {a.rules.score} → {a.rules.action}</h2>
              <div className="table-scroll fit"><table>
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
              </table></div>
            </section>
          </div>

          <EarningsPanel r={research ? research.earnings : undefined} sec={research?.sec} nextDate={f.nextEarningsDate} estimated={f.earningsDateEstimated} />
          {research?.warnings.map((w) => <div key={w} className="warn">{w}</div>)}

          <div className="grid two">
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
                <div><span>Next earnings</span><span>{f.nextEarningsDate ?? "—"}</span></div>
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
              <h2>Call history ({callsForStrategy.length})</h2>
              <div className="table-scroll fit"><table>
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
              </table></div>
            </section>
          </div>
        </div>
      )}
      <Disclaimer />
    </main>
  );
}
