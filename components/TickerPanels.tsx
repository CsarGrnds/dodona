"use client";
// Panels for the one-stop ticker page. Each one shows one skill's work for this stock.
import { Confirm, FilteredLine, OrbStatus, RecordCell, signedR, type SetupsResult } from "@/components/SetupBits";
import type { Check, CheckStatus } from "@/lib/checklist";
import { tally } from "@/lib/checklist";
import { fmt } from "@/lib/client";
import type { MarketStatus } from "@/lib/clock";
import { money, type EarningsReport } from "@/lib/earnings";
import type { ChartLevels, Level } from "@/lib/levels";
import { ORB_VOLUME_X, SWING_VOLUME_X } from "@/lib/market";
import { RISK_TAGS, tagText, type Filing } from "@/lib/news";
import { SETUP_LABEL, SWING_SETUPS } from "@/lib/setups";
import type { TimeMachineResult } from "@/lib/timemachine";
import type { Indicators, NewsItem } from "@/lib/types";

// ---------------------------------------------------------------- market clock (trader-alerts)

export function MarketClock({ st }: { st: MarketStatus }) {
  const next = st.nextOpen ? `opens ${st.nextOpen.date === st.date ? "today" : st.nextOpen.weekday} ${st.nextOpen.label} ET` : "";
  return (
    <span className={`clock ${st.open ? "open" : ""}`} title={`New York ${st.date} ${st.nowLabel}${st.calendarKnown ? "" : " · holiday calendar only covers 2026–2027"}`}>
      <i />
      {st.open ? `Market open · closes ${st.closesAt} ET${st.earlyClose ? ` (early close: ${st.earlyClose})` : ""}` : `Market closed (${st.reason}) · ${next}`}
    </span>
  );
}

// ---------------------------------------------------------------- checklist

const MARK: Record<CheckStatus, string> = { pass: "✓", warn: "!", fail: "✗", info: "•", na: "–" };

export function Checklist({ checks, loading }: { checks: Check[]; loading: string[] }) {
  const t = tally(checks);
  const groups = ["Chart", "Setup", "Plan", "Events"] as const;
  return (
    <section className="panel">
      <div className="row" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Before you trade · checklist</h2>
        <span className="spacer" />
        <span className="small mono">
          <span className="up">{t.pass} ✓</span> · <span className="caution">{t.warn} !</span> · <span className="down">{t.fail} ✗</span>
        </span>
      </div>
      <div className="checklist">
        {groups.map((g) => {
          const rows = checks.filter((c) => c.group === g);
          if (!rows.length) return null;
          return (
            <div key={g}>
              <div className="check-group">{g}</div>
              {rows.map((c) => (
                <div key={c.key} className={`check st-${c.status}`}>
                  <span className="mark">{MARK[c.status]}</span>
                  <span className="label">{c.label}</span>
                  <span className="detail">{c.detail}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {loading.length > 0 && <p className="muted small">Still loading: {loading.join(", ")}…</p>}
      <p className="muted small" style={{ marginBottom: 0 }}>A checklist for a long entry at today&apos;s price, not a call. ✓ in favor · ! caution · ✗ against.</p>
    </section>
  );
}

// ---------------------------------------------------------------- chart analysis

function LevelRow({ l, price }: { l: Level; price: number }) {
  return (
    <tr>
      <td className={l.kind === "support" ? "up" : "down"}>{l.kind === "support" ? "Support" : "Resistance"}</td>
      <td className="mono">{fmt.num(l.price)}</td>
      <td className="mono">{fmt.signedPct(l.price / price - 1)}</td>
      <td className="mono">{l.touches}×</td>
      <td className="muted small">{l.lastDate}</td>
    </tr>
  );
}

export function ChartAnalysis({ levels, ind, price }: { levels?: ChartLevels; ind: Indicators; price: number }) {
  return (
    <section className="panel">
      <h2>Chart analysis</h2>
      {levels ? (
        <div className="table-scroll fit">
          <table>
            <thead>
              <tr><th>Level</th><th>Price</th><th>From here</th><th>Touches</th><th>Last touch</th></tr>
            </thead>
            <tbody>
              {[...levels.resistances].reverse().map((l) => <LevelRow key={`r${l.price}`} l={l} price={price} />)}
              <tr className="here"><td colSpan={5} className="mono small">— price {fmt.num(price)} —</td></tr>
              {levels.supports.map((l) => <LevelRow key={`s${l.price}`} l={l} price={price} />)}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">Not enough history for levels.</p>
      )}
      <p className="muted small">Swing highs and lows over the last {levels?.lookbackDays ?? "—"} sessions, grouped within half an ATR. More touches = a level more traders watch.</p>
      <div className="kv" style={{ marginTop: 10 }}>
        <div><span>RSI 14</span><span>{fmt.num(ind.rsi14, 1)}</span></div>
        <div><span>MACD hist</span><span className={ind.macdHist !== undefined ? (ind.macdHist >= 0 ? "up" : "down") : ""}>{fmt.num(ind.macdHist, 3)}</span></div>
        <div><span>ATR 14</span><span>{fmt.num(ind.atr14)} ({ind.atr14 ? fmt.pct(ind.atr14 / price) : "—"})</span></div>
        <div><span>Volume</span><span>{ind.volumeRatio !== undefined ? `${ind.volumeRatio.toFixed(1)}× avg` : "—"}</span></div>
        <div><span>SMA 20 / 50</span><span>{fmt.num(ind.sma20)} / {fmt.num(ind.sma50)}</span></div>
        <div><span>SMA 200</span><span>{fmt.num(ind.sma200)}</span></div>
        <div><span>Bollinger</span><span>{fmt.num(ind.bbLower)}–{fmt.num(ind.bbUpper)}</span></div>
        <div><span>52w range</span><span>{fmt.num(ind.low52w)}–{fmt.num(ind.high52w)}</span></div>
        <div><span>From 52w high</span><span>{fmt.pct(ind.drawdownFromHigh)}</span></div>
        <div><span>1m · 3m · 1y</span><span>{fmt.signedPct(ind.return1m)} · {fmt.signedPct(ind.return3m)} · {fmt.signedPct(ind.return1y)}</span></div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- setups (trader-scanner, trader-entry)

export function SetupsPanel({ d, error }: { d?: SetupsResult; error?: string }) {
  if (error) return <section className="panel"><h2>Setups</h2><p className="err">{error}</p></section>;
  if (!d) return <section className="panel"><h2>Setups</h2><p className="muted small">Scanning the chart and replaying history…</p></section>;
  const sw = d.swing;
  const id = d.intraday;
  return (
    <section className="panel">
      <h2>Setups · scanner rules + track record on {d.symbol}</h2>
      {sw && (
        <>
          <p className="small" style={{ marginTop: 0 }}>
            Swing, close of {sw.lastDate}: {sw.tags.length ? <b className="up">{sw.tags.map((t) => SETUP_LABEL[t]).join(", ")}</b> : <span className="muted">no setup</span>}
          </p>
          <div className="confirm-row"><Confirm ctx={sw.context} volumeX={SWING_VOLUME_X} /></div>
          <div className="table-scroll" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr><th>Setup</th><th>Today</th><th>History on this stock</th></tr>
              </thead>
              <tbody>
                {SWING_SETUPS.map((s) => (
                  <tr key={s.key} className={sw.tags.includes(s.key) ? "hit" : ""}>
                    <td title={s.rule}>{s.label}</td>
                    <td>{sw.tags.includes(s.key) ? <span className="up">✓ fired</span> : <span className="muted">—</span>}</td>
                    <td className="small">
                      <RecordCell rec={sw.backtest.bySetup[s.key]} />
                      <FilteredLine f={sw.backtest.filtered?.[s.key]} />
                    </td>
                  </tr>
                ))}
                <tr>
                  <td className="muted">Any day</td>
                  <td />
                  <td className="small muted">
                    Same plan entered every day: {signedR(sw.backtest.baseline.avgR)} avg · win {fmt.pct(sw.backtest.baseline.winRate, 0)} · {sw.backtest.baseline.days} days. A setup has to beat this.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Stop {sw.backtest.params.stopAtr}× ATR, target {sw.backtest.params.targetR}R, up to {sw.backtest.params.maxHoldDays} sessions · {sw.backtest.from} → {sw.backtest.to}
          </p>
        </>
      )}
      {id && (
        <>
          <h2 style={{ marginTop: 16 }}>Opening-range breakout · {id.session.date}{id.session.inProgress ? " (live)" : ""}</h2>
          <div className="small">
            <OrbStatus d={id} />
            {id.orHigh !== undefined && id.orLow !== undefined && (
              <span className="muted"> · range {fmt.num(id.orLow)}–{fmt.num(id.orHigh)} · stop at the midpoint {fmt.num(id.stop)}</span>
            )}
          </div>
          {id.context && <div className="confirm-row"><Confirm ctx={id.context} volumeX={ORB_VOLUME_X} /></div>}
          <div className="small" style={{ marginTop: 6 }}>
            Last {id.backtest.sessions} sessions: <RecordCell rec={id.backtest.record} />
            <FilteredLine f={id.backtest.filtered} />
          </div>
        </>
      )}
      {d.warnings.map((w) => <div key={w} className="warn" style={{ marginTop: 8 }}>{w}</div>)}
    </section>
  );
}

// ---------------------------------------------------------------- time machine (trader-timemachine)

export function TimeMachinePanel({ tm, hypothetical }: { tm?: TimeMachineResult | null; hypothetical: boolean }) {
  return (
    <section className="panel">
      <h2>Time Machine · {tm ? `${tm.replays.toLocaleString()} replays` : "replays"}</h2>
      {!tm ? (
        <p className="muted small">Needs a stop and target (14-day ATR) and a year of daily bars.</p>
      ) : (
        <>
          <p className="small" style={{ marginTop: 0 }}>
            {hypothetical ? "If you bought here: " : ""}entry {fmt.num(tm.entry)} · stop <span className="down">{fmt.num(tm.stop)}</span> · target <span className="up">{fmt.num(tm.target)}</span> ({tm.rAtTarget}R) · up to {tm.days} sessions
          </p>
          <div className="odds">
            <div className="up" style={{ flex: tm.pTarget }} title="Target first" />
            <div className="neither" style={{ flex: tm.pNeither }} title="Neither by the time limit" />
            <div className="down" style={{ flex: tm.pStop }} title="Stop first" />
          </div>
          <div className="kv" style={{ marginTop: 10 }}>
            <div><span>Target first</span><span className="up">{fmt.pct(tm.pTarget)}</span></div>
            <div><span>Stop first</span><span className="down">{fmt.pct(tm.pStop)}</span></div>
            <div><span>Neither</span><span>{fmt.pct(tm.pNeither)}</span></div>
            <div><span>Green</span><span>{fmt.pct(tm.pGreen)}</span></div>
            <div><span>Average R</span><span className={tm.avgR >= 0 ? "up" : "down"}>{signedR(tm.avgR)}</span></div>
            {tm.medianClose !== undefined && <div><span>If still open</span><span>{fmt.num(tm.medianClose)} ({fmt.num(tm.p5Close)}–{fmt.num(tm.p95Close)})</span></div>}
            {tm.medianDaysToExit !== undefined && <div><span>Median exit</span><span>{tm.medianDaysToExit} sessions</span></div>}
          </div>
          <p className="small" style={{ marginBottom: 4 }}><b>{tm.verdict}</b></p>
          {tm.notes.map((n) => <p key={n} className="muted small" style={{ margin: "2px 0" }}>{n}</p>)}
          <p className="muted small">
            Each replay rebuilds the next {tm.days} sessions from random days of this stock&apos;s last {tm.poolDays} sessions. Stop checked first in every bar; same seed, same numbers. Not a prediction: earnings and news can do what the last year never did.
          </p>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- news + filings (trader-news)

export function NewsPanel({ news, filings, sec, changePct }: { news: NewsItem[]; filings?: Filing[]; sec?: string; changePct: number }) {
  return (
    <section className="panel">
      <h2>News & filings</h2>
      {Math.abs(changePct) >= 0.03 && <div className="warn" style={{ marginBottom: 8 }}>Moving {fmt.signedPct(changePct)} from yesterday&apos;s close.</div>}
      {news.length === 0 ? (
        <p className="muted small">No recent headlines.</p>
      ) : (
        <ul className="plain news">
          {news.map((n) => {
            const tags = tagText(n.title);
            return (
              <li key={n.link}>
                <a href={n.link} target="_blank" rel="noreferrer">{n.title}</a>{" "}
                {tags.map((t) => <span key={t} className={`tag ${RISK_TAGS.has(t) ? "risk" : ""}`}>{t}</span>)}
                <span className="muted small"> {n.publisher} · {fmt.ago(n.publishedAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
      <h2 style={{ marginTop: 14 }}>SEC EDGAR</h2>
      {sec === "no-user-agent" ? (
        <p className="muted small">SEC asks automated clients for a name and email. Add <code>SEC_USER_AGENT=&quot;Your Name you@example.com&quot;</code> to <code>.env.local</code> (or <code>sec_user_agent</code> in <code>trader/config.json</code>) and restart to see 8-Ks and reported earnings.</p>
      ) : !filings ? (
        <p className="muted small">{sec === "not-found" ? "Not in SEC's ticker list." : "Loading filings…"}</p>
      ) : filings.length === 0 ? (
        <p className="muted small">No recent filings.</p>
      ) : (
        <ul className="plain news">
          {filings.slice(0, 10).map((f) => (
            <li key={f.link}>
              <span className="mono small">{f.filed}</span> <a href={f.link} target="_blank" rel="noreferrer">{f.form}</a>{" "}
              <span className={f.important ? "" : "muted"}>{f.labels.join(", ") || (f.form.startsWith("10-") ? "periodic report" : "")}</span>{" "}
              {f.important && <span className="tag risk">important</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- earnings (trader-analyst)

const pp = (v?: number) => (v === undefined ? "—" : `${v.toFixed(1)}%`);
const yoy = (v?: number) => (v === undefined ? <span className="muted">—</span> : <span className={v >= 0 ? "up" : "down"}>{v >= 0 ? "+" : ""}{v.toFixed(1)}%</span>);

export function EarningsPanel({ r, sec, nextDate, estimated }: { r?: EarningsReport | null; sec?: string; nextDate?: string; estimated?: boolean }) {
  return (
    <section className="panel">
      <h2>Earnings · reported to the SEC</h2>
      <p className="small" style={{ marginTop: 0 }}>Next report: {nextDate ? <b>{nextDate}{estimated ? " (estimated)" : ""}</b> : <span className="muted">unknown</span>}</p>
      {sec === "no-user-agent" ? (
        <p className="muted small">Set SEC_USER_AGENT to read the quarters from SEC XBRL facts.</p>
      ) : r === undefined ? (
        <p className="muted small">Loading…</p>
      ) : !r ? (
        <p className="muted small">No quarterly XBRL facts for this company.</p>
      ) : (
        <>
          <ul className="plain small">{r.changes.map((c) => <li key={c}>{c}</li>)}</ul>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Quarter</th><th>Revenue</th><th>YoY</th><th>Gross</th><th>Oper.</th><th>Net</th><th>Net inc.</th><th>EPS</th><th>YoY</th></tr>
              </thead>
              <tbody>
                {r.rows.map((q) => (
                  <tr key={q.end}>
                    <td className="small">{q.end}<div className="muted">{q.fiscal}{q.derived ? " · derived" : ""}</div></td>
                    <td className="mono">{money(q.revenue)}</td>
                    <td className="mono">{yoy(q.revenueYoY)}</td>
                    <td className="mono">{pp(q.grossMargin)}</td>
                    <td className="mono">{pp(q.operatingMargin)}</td>
                    <td className="mono">{pp(q.netMargin)}</td>
                    <td className="mono">{money(q.netIncome)}</td>
                    <td className="mono">{q.epsDiluted !== undefined ? q.epsDiluted.toFixed(2) : "—"}</td>
                    <td className="mono">{yoy(q.epsYoY)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Trailing 12 months: revenue {money(r.ttm.revenue)} · net income {money(r.ttm.netIncome)} · EPS {r.ttm.epsDiluted?.toFixed(2) ?? "—"}. Margins are percent of revenue; YoY vs the same quarter a year earlier.
          </p>
        </>
      )}
    </section>
  );
}
