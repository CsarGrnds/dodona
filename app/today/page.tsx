"use client";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import IbkrSync from "@/components/IbkrSync";
import { MarketBanner } from "@/components/SetupBits";
import { StopTicket } from "@/components/StopTicket";
import { MarketClock } from "@/components/TickerPanels";
import { Brand, Disclaimer, Spinner } from "@/components/ui";
import { fmt } from "@/lib/client";
import { buildTradePlan } from "@/lib/plan";
import { RULE_LABELS, type DipVerdict, type StopVerdict, type TradingRules } from "@/lib/prep";
import { getPlanSettings, getRules, getWatchlist, setRules } from "@/lib/store";
import { todoList, type PrepRow, type TodayResult } from "@/lib/today";

const STOP_LABEL: Record<StopVerdict, string> = { raise: "Raise", keep: "Keep", tight: "Tight", missing: "No stop", above: "Check", partial: "Partial", hold: "Hold", "below-cost": "Under cost" };
const STOP_CLS: Record<StopVerdict, string> = { raise: "act", keep: "ok", tight: "care", missing: "bad", above: "bad", partial: "care", hold: "", "below-cost": "bad" };
const DIP_LABEL: Record<DipVerdict, string> = { discount: "Discount", watch: "Watch", none: "Not a dip", falling: "Falling" };
const DIP_CLS: Record<DipVerdict, string> = { discount: "ok", watch: "care", none: "", falling: "bad" };
const KIND_ICON = { stop: "⛨", earnings: "◷", discount: "↘", limit: "⌖" } as const;

const money = (v?: number) => (v === undefined ? "—" : `$${v.toFixed(2)}`);
const tickerHref = (s: string) => `/ticker/${encodeURIComponent(s)}`;

export default function TodayPage() {
  const [d, setD] = useState<TodayResult>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [rules, setR] = useState<TradingRules>();
  const [ticket, setTicket] = useState<string>(); // the holding whose stop ticket is open

  const load = useCallback(async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const symbols = getWatchlist().map((w) => w.symbol).join(",");
      const rl = getRules();
      setR(rl);
      const r = await fetch(`/api/today?symbols=${encodeURIComponent(symbols)}&noLoss=${rl.neverSellAtLoss ? 1 : 0}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setD(j as TodayResult);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // what needs doing first: no stop or one under cost, then raises, then the rest; holds last
  const held = useMemo(() => {
    const rank = (r: PrepRow) => ({ missing: 0, above: 0, "below-cost": 0, raise: 1, partial: 1, tight: 2, keep: 3, hold: 4 } as Record<string, number>)[r.stop?.verdict ?? ""] ?? 5;
    return (d?.rows.filter((r) => r.source.held) ?? []).map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
  }, [d]);
  const todos = useMemo(() => (d ? todoList(d.rows) : []), [d]);
  const dips = useMemo(() => {
    const rank: Record<DipVerdict, number> = { discount: 0, watch: 1, falling: 2, none: 3 };
    return (d?.rows ?? []).filter((r) => r.dip && r.dip.verdict !== "none").sort((a, b) => rank[a.dip!.verdict] - rank[b.dip!.verdict]);
  }, [d]);
  const limits = useMemo(() => (d?.rows ?? []).flatMap((r) => (r.limits ?? []).map((l) => ({ row: r, ...l }))), [d]);
  const ordersReady = d?.orders.state === "ready";
  const toggleRule = (k: keyof TradingRules) => {
    if (!rules) return;
    setRules({ ...rules, [k]: !rules[k] });
    load();
  };

  return (
    <main className="shell">
      <div className="topbar">
        <Brand sub="today · daily prep" />
        <div className="row">
          <Link className="btn ghost" href="/">Watchlist</Link>
          <Link className="btn ghost" href="/setups">Setups</Link>
          <Link className="btn ghost" href="/portfolio">Portfolio</Link>
          <Link className="btn ghost" href="/desk">Desk</Link>
          <Link className="btn ghost" href="/status">Status</Link>
          <Link className="btn ghost" href="/settings">Settings</Link>
          <button className="btn primary" onClick={load} disabled={busy}>{busy ? <Spinner /> : "↻"} Refresh</button>
        </div>
      </div>

      {err && <div className="panel err" style={{ marginBottom: 14 }}>{err}</div>}
      {!d && !err && <div className="panel"><Spinner /> <span className="muted">Reading your positions, IBKR orders and charts…</span></div>}

      {d && (
        <div className="grid" style={{ gap: 14 }}>
          <section className="panel row">
            <MarketClock st={d.clock} />
            <span className={`clock ${ordersReady ? "open" : ""}`} title={d.orders.url}>
              <i />
              {ordersReady ? `IBKR: ${d.orders.count} open order${d.orders.count === 1 ? "" : "s"} read` : d.orders.state === "login" ? "IBKR gateway: log in to read your stops" : d.orders.state === "down" ? "IBKR gateway not running: stops unknown" : "IBKR orders unavailable"}
            </span>
            {d.portfolio && <span className="muted small">Positions synced {fmt.ago(d.portfolio.syncedAt)}</span>}
            <span className="spacer" />
            <IbkrSync onSynced={() => load()} label="Sync positions" />
          </section>
          {!ordersReady && (
            <div className="warn">
              Without the IBKR gateway Dodona can&apos;t see the stops you already have, so every holding shows as “No stop”.{" "}
              {d.orders.state === "login" ? (
                <>Log in at <a href={d.orders.url} target="_blank" rel="noreferrer">{d.orders.url}</a>, then Refresh.</>
              ) : (
                <>Ask Claude to “refresh IBKR” (the /ibkr-gateway skill starts it), then Refresh.</>
              )}
            </div>
          )}
          {d.market && <MarketBanner m={d.market} />}

          {rules && (
            <section className="panel">
              <h2>Your rules</h2>
              <div className="rules">
                {(Object.keys(RULE_LABELS) as Array<keyof TradingRules>).map((k) => (
                  <label key={k} className="rule">
                    <input type="checkbox" checked={rules[k]} onChange={() => toggleRule(k)} disabled={busy} />
                    <span>
                      <b>{RULE_LABELS[k].label}</b>
                      <span className="muted small"> · {RULE_LABELS[k].detail}</span>
                    </span>
                  </label>
                ))}
              </div>
            </section>
          )}

          <section className="panel">
            <h2>Before the bell · {todos.length ? `${todos.length} to do` : "nothing to change"}</h2>
            {todos.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>Every stop is at or above the rule, no earnings this week in what you hold, no discounts flagged.</p>
            ) : (
              <ol className="todo">
                {todos.map((t, i) => (
                  <li key={i} className={`u${t.urgency}`}>
                    <span className="icon" title={t.kind}>{KIND_ICON[t.kind]}</span>
                    <Link href={tickerHref(t.symbol)} className="mono">{t.symbol}</Link>
                    <span>{t.text}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="panel">
            <h2>Stops · your holdings</h2>
            {held.length === 0 ? (
              <p className="muted small">No synced holdings. <IbkrSync onSynced={() => load()} label="Sync from IBKR" /></p>
            ) : (
              <div className="table-scroll fit">
                <table>
                  <thead>
                    <tr>
                      <th>Ticker</th><th>Price</th><th>Cost</th><th>Your stop</th><th>Rule stop</th><th>Advice</th><th>Loss at stop</th>
                    </tr>
                  </thead>
                  <tbody>
                    {held.map((r) => (
                      <Fragment key={r.symbol}>
                        <StopRow r={r} canTicket={ordersReady} open={ticket === r.symbol} onTicket={() => setTicket(ticket === r.symbol ? undefined : r.symbol)} />
                        {ticket === r.symbol && r.stop && (
                          <tr className="st-row">
                            <td colSpan={7}>
                              <StopTicket symbol={r.symbol} suggested={r.stop.suggested} price={r.price} noLoss={d.rules.neverSellAtLoss} onClose={() => setTicket(undefined)} onSent={() => setTimeout(load, 2500)} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted small" style={{ marginBottom: 0 }}>
              Rule stop = the highest of: the 22-day high − 3 × ATR (2 × when the stock is stretched), ½ ATR under the nearest support with 2+ touches, and your average cost once you&apos;re 3 ATRs up; never within 1 ATR of the price. A stock already more than 3 ATRs off its high (“off its high”) has crossed its trail, so support or 2 ATRs is used instead. Stops only move up. “Loss at stop” is from today&apos;s price; a gap can fill worse. With “Never sell at a loss” on, no stop goes under your cost: a position under water (or less than 1 ATR above cost) shows Hold, and a stop under cost is flagged.
            </p>
          </section>

          <section className="panel">
            <h2>Discounts · pullbacks worth a look</h2>
            {dips.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>Nothing in your holdings, buy limits or watchlist is pulled back right now.</p>
            ) : (
              <div className="table-scroll fit">
                <table>
                  <thead>
                    <tr>
                      <th>Ticker</th><th>Verdict</th><th>Why</th><th>If you add</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dips.map((r) => (
                      <DipRow key={r.symbol} r={r} d={d} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted small" style={{ marginBottom: 0 }}>
              Discount = in an uptrend (above the 200-day, 50-day above it) with 2+ of: within 1 ATR of a support with 2+ touches, RSI ≤ 40 or back at the 50-day average, an oversold bounce or a reclaimed 20-day average. In a downtrend a lower price is “Falling”, not a discount. The add plan uses your Trade plan settings and this account.
            </p>
          </section>

          {limits.length > 0 && (
            <section className="panel">
              <h2>Resting buy limits at IBKR</h2>
              <div className="table-scroll fit">
                <table>
                  <thead>
                    <tr>
                      <th>Ticker</th><th>Order</th><th>Price</th><th>Check</th>
                    </tr>
                  </thead>
                  <tbody>
                    {limits.map(({ row, order, check }) => (
                      <tr key={order.orderId}>
                        <td><Link href={tickerHref(row.symbol)} className="mono">{row.symbol}</Link></td>
                        <td className="mono small">{order.desc || `Buy ${order.qty} @ ${money(order.limit)}`}</td>
                        <td className="mono">{money(row.price)}</td>
                        <td>
                          <span className={`pill ${check.verdict === "at-support" ? "ok" : check.verdict === "fills" ? "act" : row.trend === "down" ? "bad" : ""}`}>{check.headline}</span>
                          <div className="small muted">{check.detail}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {d.rows.some((r) => r.error) && (
            <div className="warn">Couldn&apos;t read: {d.rows.filter((r) => r.error).map((r) => `${r.symbol} (${r.error})`).join(", ")}</div>
          )}
          {d.warnings.length > 0 && <div className="warn">{d.warnings.join(" · ")}</div>}
          <p className="muted small">
            Dodona reads your orders from IBKR; the only ones it changes are stops you send from a ticket above. Change buy limits in IBKR (TWS, IBKR Mobile or the Client Portal). Prices are Yahoo&apos;s, as of {new Date(d.asOf).toLocaleString()}.
          </p>
        </div>
      )}
      <Disclaimer />
    </main>
  );
}

/** A stop the rule says to set or raise, below the price: it can become a ticket for IBKR. */
const ticketable = (r: PrepRow) => {
  const s = r.stop;
  if (!s || !r.price || !(s.suggested < r.price)) return false;
  // IBKR's API can't modify a fractional order: those stops are raised in IBKR itself
  if ((r.orders ?? []).some((o) => o.side === "SELL" && o.stop !== undefined && !Number.isInteger(o.qty))) return false;
  if (s.verdict === "raise" || s.verdict === "missing") return true;
  return s.verdict === "below-cost" && (s.current === undefined || s.suggested > s.current);
};

function StopRow({ r, canTicket, open, onTicket }: { r: PrepRow; canTicket: boolean; open: boolean; onTicket: () => void }) {
  if (r.error) {
    return (
      <tr>
        <td className="mono">{r.symbol}</td>
        <td colSpan={6} className="err">{r.error}</td>
      </tr>
    );
  }
  const s = r.stop;
  const stops = (r.orders ?? []).filter((o) => o.side === "SELL" && o.stop !== undefined);
  const pnl = r.position && r.price ? r.price / r.position.avgCost - 1 : undefined;
  return (
    <tr>
      <td>
        <Link href={tickerHref(r.symbol)} className="mono">{r.symbol}</Link>
        {r.earningsInDays !== undefined && <span className="tag risk" title={`Earnings ${r.nextEarnings}`}>earnings {r.earningsInDays}d</span>}
        <div className="muted small">{+(r.position?.shares ?? 0).toFixed(4)} sh</div>
      </td>
      <td className="mono">
        {money(r.price)}
        <div className={`small ${(r.changePct ?? 0) >= 0 ? "up" : "down"}`}>{fmt.signedPct(r.changePct ?? 0)}</div>
      </td>
      <td className="mono">
        {money(r.position?.avgCost)}
        {pnl !== undefined && <div className={`small ${pnl >= 0 ? "up" : "down"}`}>{fmt.signedPct(pnl)}</div>}
      </td>
      <td className="mono">
        {stops.length ? stops.map((o) => <div key={o.orderId} title={o.desc}>{money(o.stop)}{o.kind !== "stop" ? <span className="muted small"> {o.kind}</span> : null}</div>) : <span className="muted">none</span>}
      </td>
      <td className="mono" style={{ minWidth: 140 }} title={r.suggestion?.candidates.map((c) => `${c.key}: $${c.price.toFixed(2)} — ${c.detail}`).join("\n")}>
        <div className="nowrap">{s?.verdict === "hold" ? <span className="muted">—</span> : money(s?.suggested ?? r.suggestion?.price)}</div>
        <div className="chips">
          {s?.rule ? <span className="chip" title={s.rule}>your rule</span> : r.suggestion && <span className="chip" title="What set the rule stop">{r.suggestion.basis === "floor" ? "1 ATR floor" : r.suggestion.basis === "fallback" ? "2 ATRs" : r.suggestion.basis}</span>}
          {r.suggestion?.trailBroken && <span className="chip care" title="Already fell past the 3-ATR trailing stop from its 22-day high">off high</span>}
        </div>
      </td>
      <td style={{ minWidth: 260 }}>
        {s ? (
          <>
            <span className={`pill ${STOP_CLS[s.verdict]}`}>{STOP_LABEL[s.verdict]}</span> <b className="small">{s.headline}</b>
            {s.verdict === "hold" ? (
              <details className="why small muted">
                <summary>Why</summary>
                {s.detail}
              </details>
            ) : (
              <div className="small muted">{s.detail}</div>
            )}
            {canTicket && (s.verdict === "raise" || s.verdict === "below-cost") && !ticketable(r) && stops.some((o) => !Number.isInteger(o.qty)) && (
              <div className="small muted" style={{ marginTop: 4 }}>Fractional stop: IBKR doesn&apos;t let Dodona change it, so raise it in IBKR.</div>
            )}
            {canTicket && ticketable(r) && (
              <button className={`btn ${open ? "" : "ghost"} st-open`} onClick={onTicket} title="A ticket for IBKR: you see it in full and send it only on your yes">
                {open ? "Close ticket" : s.current !== undefined ? `Raise to $${s.suggested.toFixed(2)} at IBKR…` : `Set $${s.suggested.toFixed(2)} at IBKR…`}
              </button>
            )}
          </>
        ) : (
          <span className="muted small">Not enough history for a stop</span>
        )}
      </td>
      <td className="mono small nowrap">
        {s?.riskNow !== undefined && <div>{s.riskNow < 0 ? <span className="up">+{money(-s.riskNow)} locked</span> : money(s.riskNow)}</div>}
        {s && (s.verdict === "raise" || s.verdict === "missing") && <div className="muted">→ {s.riskAfter < 0 ? <span className="up">+{money(-s.riskAfter)} locked</span> : money(s.riskAfter)}</div>}
      </td>
    </tr>
  );
}

function DipRow({ r, d }: { r: PrepRow; d: TodayResult }) {
  const dip = r.dip!;
  const plan = useMemo(() => {
    if (!r.price || !dip.addStop || dip.verdict === "falling") return undefined;
    const s = getPlanSettings();
    const heldValue = r.position && r.price ? r.position.shares * r.price : 0;
    return buildTradePlan(
      { symbol: r.symbol, action: "BUY", price: r.price, stop: dip.addStop },
      s,
      d.portfolio ? { netLiquidation: d.portfolio.netLiquidation, cash: d.portfolio.cash, heldValue } : undefined,
    );
  }, [r, dip, d.portfolio]);
  const tags = [r.source.held && "held", r.source.buyLimit && "buy limit", r.source.watch && "watchlist"].filter(Boolean) as string[];
  return (
    <tr>
      <td>
        <Link href={tickerHref(r.symbol)} className="mono">{r.symbol}</Link> <span className="mono small">{money(r.price)}</span>
        <div>{tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>
      </td>
      <td>
        <span className={`pill ${DIP_CLS[dip.verdict]}`}>{DIP_LABEL[dip.verdict]}</span>
        <div className="small muted">{dip.headline}</div>
      </td>
      <td className="small">
        <ul className="reasons">{dip.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>
      </td>
      <td className="small">
        {dip.verdict === "falling" ? (
          <span className="muted">No add plan in a downtrend</span>
        ) : plan?.status === "READY" ? (
          <>
            <b>{plan.shares} sh</b> at ~{money(plan.entry)}, stop {money(plan.stop)} ({dip.addStop!.why})
            <div className="muted">Max loss {money(plan.maxLoss)} · target {money(plan.target)} · sized by {plan.sizedBy}</div>
            {d.rules.neverSellAtLoss && <div className="caution">Under your no-loss rule you&apos;d hold instead of selling at this stop: it sizes the add and shows how far under water you could go.</div>}
          </>
        ) : plan ? (
          <span className="muted" title={plan.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`).join("\n")}>{plan.reason}</span>
        ) : (
          "—"
        )}
      </td>
    </tr>
  );
}
