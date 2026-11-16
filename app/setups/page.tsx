"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Brand, Disclaimer, Spinner } from "@/components/ui";
import { Confirm, Edge, FilteredLine, MarketBanner, OrbStatus, PlanCell, RecordCell, signedR, type SetupsResult } from "@/components/SetupBits";
import type { TrackRecord } from "@/lib/backtest";
import { ORB_VOLUME_X, SWING_VOLUME_X } from "@/lib/market";
import { fetchPortfolio, fmt } from "@/lib/client";
import { buildTradePlan, type AccountContext, type PlanSettings, type TradePlan } from "@/lib/plan";
import { findHolding, type Portfolio } from "@/lib/portfolio";
import { SETUP_LABEL, SWING_SETUPS, type SwingSetup } from "@/lib/setups";
import { getPlanSettings, getSetupExtras, getWatchlist, setSetupExtras } from "@/lib/store";

type Row = { data?: SetupsResult; error?: string; busy?: boolean };

const PARALLEL = 3;
const MAX_HOLD = 20;

export default function SetupsPage() {
  const [pf, setPf] = useState<Portfolio | null>(null);
  const [settings, setSettings] = useState<PlanSettings>();
  const [extras, setExtras] = useState<string[]>([]);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [running, setRunning] = useState(false);
  const [add, setAdd] = useState("");

  useEffect(() => {
    setSettings(getPlanSettings());
    setExtras(getSetupExtras());
    fetchPortfolio()
      .then(setPf)
      .catch(() => setPf(null))
      .finally(() => setPfLoaded(true));
  }, []);
  const [pfLoaded, setPfLoaded] = useState(false);

  // Universe: IBKR holdings + watchlist + extras, de-duplicated.
  useEffect(() => {
    if (!pfLoaded) return;
    const all = [...(pf?.positions.map((p) => p.ticker) ?? []), ...getWatchlist().map((w) => w.symbol), ...extras];
    setSymbols([...new Set(all.map((s) => s.toUpperCase()))]);
  }, [pf, pfLoaded, extras]);

  const scan = useCallback(
    async (list: string[]) => {
      if (!settings) return;
      setRunning(true);
      const queue = [...list];
      const q = `&stopAtr=${settings.stopAtr}&targetR=${settings.targetR}&maxHold=${MAX_HOLD}`;
      const worker = async () => {
        for (let sym = queue.shift(); sym; sym = queue.shift()) {
          setRows((r) => ({ ...r, [sym]: { ...r[sym], busy: true } }));
          try {
            const res = await fetch(`/api/setups?symbol=${encodeURIComponent(sym)}${q}`, { cache: "no-store" });
            const d = await res.json();
            if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
            setRows((r) => ({ ...r, [sym]: { data: d as SetupsResult } }));
          } catch (e) {
            setRows((r) => ({ ...r, [sym]: { error: e instanceof Error ? e.message : String(e) } }));
          }
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      setRunning(false);
    },
    [settings],
  );

  useEffect(() => {
    const missing = symbols.filter((s) => !rows[s]);
    if (missing.length && settings) scan(missing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbols, settings]);

  const acctFor = (sym: string, price: number): AccountContext | undefined => {
    if (!pf) return undefined;
    const h = findHolding(pf, sym);
    return { netLiquidation: pf.netLiquidation, cash: pf.cash, heldValue: h ? h.shares * price : 0, heldShares: h?.shares };
  };

  // ---------- swing rows: one per (ticker, setup that fired on the last daily close)
  const swingRows = useMemo(() => {
    const out: Array<{ sym: string; tag: SwingSetup; d: NonNullable<SetupsResult["swing"]>; rec: TrackRecord; edge: number; plan?: TradePlan }> = [];
    for (const sym of symbols) {
      const d = rows[sym]?.data?.swing;
      if (!d) continue;
      for (const tag of d.tags) {
        const rec = d.backtest.bySetup[tag];
        const plan = settings ? buildTradePlan({ symbol: sym, action: "BUY", price: d.close, atr14: d.atr14 }, settings, acctFor(sym, d.close)) : undefined;
        out.push({ sym, tag, d, rec, edge: rec.trades ? rec.avgR - d.backtest.baseline.avgR : -99, plan });
      }
    }
    return out.sort((a, b) => Number(b.rec.sample === "ok") - Number(a.rec.sample === "ok") || b.edge - a.edge);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, symbols, settings, pf]);

  // ---------- intraday rows: one per ticker
  const orbRows = useMemo(() => {
    const out: Array<{ sym: string; d: NonNullable<SetupsResult["intraday"]>; plan?: TradePlan }> = [];
    for (const sym of symbols) {
      const d = rows[sym]?.data?.intraday;
      if (!d) continue;
      const plan =
        d.hit && d.stop !== undefined && settings
          ? buildTradePlan(
              { symbol: sym, action: "BUY", price: d.hit.price, stop: { price: d.stop, why: `opening-range midpoint (${fmt.num(d.hit.orLow)}–${fmt.num(d.hit.orHigh)})` } },
              { ...settings, minStopPct: 0.001 }, // intraday stops are tight by design; only refuse sub-0.1% stops
              acctFor(sym, d.hit.price),
            )
          : undefined;
      out.push({ sym, d, plan });
    }
    const rank = { triggered: 0, waiting: 1, forming: 2, "no-breakout": 3 };
    return out.sort((a, b) => rank[a.d.status] - rank[b.d.status] || b.d.backtest.record.avgR - a.d.backtest.record.avgR);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, symbols, settings, pf]);

  const swingMarket = symbols.map((s) => rows[s]?.data?.swing?.market).find(Boolean);
  const done = symbols.filter((s) => rows[s]?.data || rows[s]?.error).length;
  const errors = symbols.filter((s) => rows[s]?.error);
  const noSetup = symbols.filter((s) => rows[s]?.data?.swing && !rows[s]!.data!.swing!.tags.length);
  const latestSession = orbRows[0]?.d.session;

  const addExtra = () => {
    const syms = add.toUpperCase().split(/[\s,]+/).filter((s) => /^[A-Z0-9.\-^=]{1,15}$/.test(s));
    if (!syms.length) return;
    setExtras((prev) => {
      const next = [...new Set([...prev, ...syms])];
      setSetupExtras(next);
      return next;
    });
    setAdd("");
  };
  const removeExtra = (s: string) =>
    setExtras((prev) => {
      const next = prev.filter((x) => x !== s);
      setSetupExtras(next);
      return next;
    });

  return (
    <main className="shell">
      <div className="topbar">
        <Brand sub="setups · swing + intraday" />
        <div className="row">
          <Link className="btn ghost" href="/">Watchlist</Link>
          <Link className="btn ghost" href="/today">Today</Link>
          <Link className="btn ghost" href="/portfolio">Portfolio</Link>
          <Link className="btn ghost" href="/status">Status</Link>
          <button className="btn primary" onClick={() => { setRows({}); scan(symbols); }} disabled={running || !symbols.length}>
            {running ? <><Spinner /> {done}/{symbols.length}</> : "Rescan"}
          </button>
        </div>
      </div>

      <section className="panel" style={{ marginBottom: 14 }}>
        <div className="row">
          <span className="muted small">
            Scanning {symbols.length} tickers: {pf ? `${pf.positions.length} IBKR holdings` : "no IBKR sync"} + watchlist{extras.length ? ` + ${extras.length} added` : ""}.
          </span>
          <span className="spacer" />
          <form className="row" onSubmit={(e) => { e.preventDefault(); addExtra(); }}>
            <input className="add-input" value={add} onChange={(e) => setAdd(e.target.value)} placeholder="Add tickers, e.g. TSLA AMD" aria-label="Add tickers to scan" />
            <button className="btn" type="submit">Add</button>
          </form>
        </div>
        {extras.length > 0 && (
          <div className="row" style={{ marginTop: 8 }}>
            {extras.map((s) => (
              <button key={s} className="chip" onClick={() => removeExtra(s)} title="Remove from the scan">{s} ×</button>
            ))}
          </div>
        )}
        {errors.length > 0 && <p className="err" style={{ marginBottom: 0 }}>No data for {errors.join(", ")}.</p>}
      </section>

      <div className="grid" style={{ gap: 14 }}>
        {swingMarket && <MarketBanner m={swingMarket} />}
        <section className="panel">
          <h2>Swing setups · last daily close{swingRows[0] ? ` (${swingRows[0].d.lastDate})` : ""}</h2>
          <p className="muted small" style={{ marginTop: -6 }}>
            The scanner&apos;s daily rules. Track record: every past day the setup fired on that stock (~3 years), traded with your plan ({settings?.stopAtr ?? 2}×ATR stop, {settings?.targetR ?? 2}R target, exit after {MAX_HOLD} days), vs the same plan entered on any day.
          </p>
          {swingRows.length === 0 ? (
            <p className="muted small">{running ? "Scanning…" : "No swing setups on the last close."}</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>Ticker</th><th>Setup</th><th>Close</th><th>Confirmation</th><th>Plan</th><th>Track record on this stock</th><th>vs any day</th></tr>
                </thead>
                <tbody>
                  {swingRows.map(({ sym, tag, d, rec, plan }) => (
                    <tr key={`${sym}-${tag}`}>
                      <td><Link className="mono" href={`/ticker/${encodeURIComponent(sym)}?strategy=swing`}>{sym}</Link>{findHolding(pf, sym) && <div className="muted small">held</div>}</td>
                      <td title={SWING_SETUPS.find((s) => s.key === tag)?.rule}>{SETUP_LABEL[tag]}{tag.startsWith("oversold") && d.numbers.rsi !== undefined && <div className="muted small">RSI {d.numbers.rsi.toFixed(0)}</div>}</td>
                      <td className="mono">{fmt.num(d.close)}</td>
                      <td className="small"><Confirm ctx={d.context} volumeX={SWING_VOLUME_X} /></td>
                      <td className="small"><PlanCell plan={plan} /></td>
                      <td className="small"><RecordCell rec={rec} /><FilteredLine f={d.backtest.filtered?.[tag]} /></td>
                      <td className="small mono">
                        <Edge r={rec.trades ? rec.avgR - d.backtest.baseline.avgR : undefined} />
                        <div className="muted">any day {signedR(d.backtest.baseline.avgR)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {noSetup.length > 0 && <p className="muted small" style={{ marginBottom: 0 }}>No setup on the last close: {noSetup.join(", ")}.</p>}
        </section>

        <section className="panel">
          <h2>Intraday · opening-range breakout{latestSession ? ` · session ${latestSession.date}${latestSession.inProgress ? " (live)" : ""}` : ""}</h2>
          <p className="muted small" style={{ marginTop: -6 }}>
            Entry: the first 5-minute close above the first 15 minutes&apos; high. Stop: the range midpoint. Target: {settings?.targetR ?? 2}R. Flat by the close. Track record: the same rule on each of the last ~60 full sessions (the Time Machine&apos;s history replay); a bar touching both stop and target counts as the stop.
          </p>
          {orbRows.length === 0 ? (
            <p className="muted small">{running ? "Scanning…" : "No intraday data."}</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>Ticker</th><th>Status</th><th>Opening range</th><th>Confirmation</th><th>Plan</th><th>Last ~60 sessions</th></tr>
                </thead>
                <tbody>
                  {orbRows.map(({ sym, d, plan }) => (
                    <tr key={sym}>
                      <td><Link className="mono" href={`/ticker/${encodeURIComponent(sym)}?strategy=swing`}>{sym}</Link>{findHolding(pf, sym) && <div className="muted small">held</div>}</td>
                      <td className="small"><OrbStatus d={d} /></td>
                      <td className="mono small">{d.orLow !== undefined ? `${fmt.num(d.orLow)}–${fmt.num(d.orHigh)}` : "—"}</td>
                      <td className="small">{d.context ? <Confirm ctx={d.context} volumeX={ORB_VOLUME_X} /> : <span className="muted">—</span>}</td>
                      <td className="small">
                        {!d.hit ? (
                          <span className="muted">—</span>
                        ) : d.session.inProgress ? (
                          <PlanCell plan={plan} />
                        ) : (
                          <div className="past-plan" title="This breakout happened in a finished session; the plan is shown for reference, not to act on.">
                            <span className="muted">Past session · was:</span> <PlanCell plan={plan} />
                          </div>
                        )}
                      </td>
                      <td className="small">
                        <RecordCell rec={d.backtest.record} />
                        <div className="muted">fired {d.backtest.record.trades} of {d.backtest.sessions} sessions</div>
                        <FilteredLine f={d.backtest.filtered} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="muted small">
          Confirmation: <b>Market</b> = SPY above its 50-day average (intraday: as of the previous close); <b>RS</b> = 3-month return minus SPY&apos;s; <b>Vol</b> = swing: setup-day volume vs the 20-day average (≥{SWING_VOLUME_X}×), intraday: breakout bar vs the opening-range bars (≥{ORB_VOLUME_X}×, trader-entry&apos;s check). &quot;When confirmed&quot; shows the track record of only the past trades where that check passed. A track record is how a rule did in the past on this stock, not a forecast: earnings, news and gaps can do things the history never did. R = profit in units of the risk per share (+2R = twice what you risked, −1R = stopped out). No commissions or slippage; a gap through the stop counts −1R but a real fill can be worse. Use the Time Machine skill (<span className="mono">/trader-timemachine</span>) for 10,000 simulated sessions of a live intraday plan.
        </p>
      </div>
      <Disclaimer />
    </main>
  );
}
