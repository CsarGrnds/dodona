"use client";
// The Desk's "Today's analysis" board: one card per stock the trade team looked at, grouped by run, with
// the chart the chartist drew and read, the levels, the verdict, the coach's replay after the close and
// the IBKR ticket it became. Read-only.
import { useEffect, useMemo, useState } from "react";
import { Spinner } from "@/components/ui";
import { clockLabel } from "@/lib/setups";
import type { Analysis, CandidateCard, Ticket } from "@/lib/analysis";

const OUTCOME: Record<string, string> = { target: "Hit the target", stop: "Hit the stop", close: "Sold at the close", "not-triggered": "Never triggered", "no-data": "No bars to replay" };
const TICKET: Record<Ticket["status"], { label: string; cls: string }> = {
  staged: { label: "Staged · waiting for your OK", cls: "act" },
  approved: { label: "Approved", cls: "act" },
  placed: { label: "Sent to IBKR", cls: "ok" },
  filled: { label: "Filled at IBKR", cls: "ok" },
  failed: { label: "IBKR refused it", cls: "bad" },
  declined: { label: "Declined", cls: "" },
  canceled: { label: "Canceled", cls: "" },
};
const MARKET: Record<string, string> = { aggressive: "ok", normal: "", defensive: "care" };
const pct = (a: number, b: number) => `${a >= b ? "+" : "−"}${(Math.abs(a / b - 1) * 100).toFixed(1)}%`;
const px = (v: number) => (v < 10 ? v.toFixed(3).replace(/0$/, "") : v.toFixed(2));
const usd = (v?: number) => (v === undefined ? "—" : `$${v.toFixed(2)}`);
const chartUrl = (f: string) => `/api/desk/chart/${encodeURIComponent(f)}`;
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

type Filter = "all" | "take" | "skip" | "ticket";

export function TeamAnalysis({ tick = 0 }: { tick?: number }) {
  const [a, setA] = useState<Analysis>();
  const [err, setErr] = useState<string>();
  const [date, setDate] = useState<string>();
  const [filter, setFilter] = useState<Filter>("all");
  const [zoom, setZoom] = useState<{ file: string; title: string }>();

  useEffect(() => {
    let on = true;
    const load = () =>
      fetch(`/api/desk/analysis${date ? `?date=${date}` : ""}`, { cache: "no-store" })
        .then(async (r) => {
          const j = await r.json();
          if (!on) return;
          if (!r.ok) setErr(j.error ?? `HTTP ${r.status}`);
          else {
            setErr(undefined);
            setA(j);
          }
        })
        .catch(() => on && setErr("Couldn't read the team's analysis."));
    load();
    const id = setInterval(load, 30_000);
    return () => {
      on = false;
      clearInterval(id);
    };
  }, [date, tick]);

  useEffect(() => {
    if (!zoom) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setZoom(undefined);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [zoom]);

  const runs = useMemo(
    () =>
      (a?.runs ?? [])
        .map((r) => ({ ...r, cards: r.cards.filter((c) => filter === "all" || (filter === "ticket" ? !!c.ticket : c.verdict === filter)) }))
        .filter((r) => r.cards.length),
    [a, filter],
  );

  if (err) return <div className="err">{err}</div>;
  if (!a) return <div className="muted small"><Spinner /> Reading the team&apos;s analysis…</div>;
  if (!a.dates.length)
    return <div className="dk-empty">Nothing analyzed yet. Each stock the trade team looks at shows here with its chart, the chartist&apos;s read, the levels and the verdict.</div>;

  const t = a.totals;
  return (
    <div className="an">
      <div className="row an-head">
        <select className="as-pick" value={a.date} onChange={(e) => setDate(e.target.value)} aria-label="Day">
          {a.dates.map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}
        </select>
        <span className="small an-stat"><b>{t.looked}</b> analyzed</span>
        <span className="small an-stat"><b>{t.taken}</b> taken</span>
        <span className="small an-stat"><b>{t.tickets}</b> ticket{t.tickets === 1 ? "" : "s"}</span>
        {t.reviewed > 0 && (
          <span className="small an-stat" title="The coach's replay of every candidate on that day's real 5-minute bars, after the close">
            Coach: <b>{t.rightCalls}/{t.reviewed}</b> right calls{t.avgR !== undefined ? ` · avg ${t.avgR >= 0 ? "+" : ""}${t.avgR}R if all taken` : ""}
          </span>
        )}
        <span className="spacer" />
        <div className="seg">
          {(["all", "take", "skip", "ticket"] as const).map((f) => (
            <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f === "all" ? "All" : f === "take" ? "Taken" : f === "skip" ? "Skipped" : "Tickets"}</button>
          ))}
        </div>
      </div>

      {runs.length === 0 && <div className="dk-empty">Nothing matches this filter on {dayLabel(a.date)}.</div>}
      {runs.map((r) => (
        <section key={`${r.mode}-${r.minute}`} className="an-run">
          <div className="an-run-head">
            <div>
              <div className="an-run-title">{clockLabel(r.minute)} ET run</div>
              <div className="row small" style={{ gap: 6, marginTop: 4 }}>
                <span className={`pill ${r.mode === "live" ? "bad" : "act"}`}>{r.mode === "live" ? "IBKR batch" : "Paper"}</span>
                {r.marketMode && <span className={`pill ${MARKET[r.marketMode] ?? ""}`} title="From SPY against its VWAP and its 20- and 50-day averages">Market {r.marketMode}</span>}
                {r.marketChart && (
                  <button className="btn ghost an-view" onClick={() => setZoom({ file: r.marketChart!, title: `SPY · the market at ${clockLabel(r.minute)} ET` })} title="The market (SPY) the team read before this run">◫ Market</button>
                )}
                <span className="muted">{r.cards.length} stock{r.cards.length === 1 ? "" : "s"} analyzed · {r.cards.filter((c) => c.verdict === "take").length} taken</span>
              </div>
            </div>
          </div>
          <div className="an-cards">
            {r.cards.map((c) => <Card key={`${c.at}-${c.symbol}`} c={c} onZoom={setZoom} />)}
          </div>
        </section>
      ))}

      {zoom && (
        <div className="an-zoom" role="dialog" aria-label={zoom.title} onClick={() => setZoom(undefined)}>
          <figure onClick={(e) => e.stopPropagation()}>
            <figcaption className="row">
              <b>{zoom.title}</b>
              <span className="spacer" />
              <button className="btn ghost" onClick={() => setZoom(undefined)}>Close</button>
            </figcaption>
            <img src={chartUrl(zoom.file)} alt={zoom.title} />
          </figure>
        </div>
      )}
    </div>
  );
}

function Card({ c, onZoom }: { c: CandidateCard; onZoom: (z: { file: string; title: string }) => void }) {
  const risk = c.trigger - c.stop;
  const rr = risk > 0 ? (c.target - c.trigger) / risk : 0;
  const rev = c.review;
  const verdictOf = rev && rev.outcome !== "no-data" ? (rev.rightCall === true ? "right" : rev.rightCall === false ? (c.verdict === "skip" ? "missed" : "wrong") : "none") : undefined;
  return (
    <article className={`an-card ${c.verdict}`}>
      <div className="an-body">
        <div className="row" style={{ gap: 8 }}>
          <a href={`/ticker/${encodeURIComponent(c.symbol)}`} className="dk-sym">{c.symbol}</a>
          <span className={`pill ${c.verdict === "take" ? "ok" : ""}`}>{c.verdict === "take" ? "TAKE" : "SKIP"}</span>
          <span className="muted small">{c.setup.toUpperCase()}</span>
          <span className="spacer" />
          <span className="muted small">{clockLabel(c.minute)} ET</span>
          {c.chart && (
            <button className="btn ghost an-view" onClick={() => onZoom({ file: c.chart!, title: `${c.symbol} · the chart the chartist read at ${clockLabel(c.minute)} ET` })} title="Daily, 15-minute and today's 5-minute chart with the trigger, stop and target">
              ◫ Chart
            </button>
          )}
        </div>
        {c.chartScore !== undefined && (
          <div className="row small" style={{ gap: 8 }} title="The chartist's score after reading the charts as images. 1-2 is a skip; a defensive market needs 4-5. Click ◫ Chart to see what it read.">
            <span className="muted">Chart</span>
            <span className={`an-score s${c.chartScore}`}>
              {[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= c.chartScore! ? "on" : ""} />)}
            </span>
            <b>{c.chartScore}/5</b>
          </div>
        )}
        <div className="an-levels mono small">
          <span><em>Trigger</em>{px(c.trigger)}</span>
          <span className="down"><em>Stop</em>{px(c.stop)} <small>{pct(c.stop, c.trigger)}</small></span>
          <span className="up"><em>Target</em>{px(c.target)} <small>{pct(c.target, c.trigger)}</small></span>
          <span><em>Reward:risk</em>{rr.toFixed(1)}</span>
        </div>
        <p className="an-why small">{c.why}</p>
        {(rev || c.ticket) && (
          <div className="an-foot">
            {c.ticket && (
              <span className={`pill ${TICKET[c.ticket.status]?.cls ?? ""}`} title="The order this analysis became at IBKR">
                ⇢ {TICKET[c.ticket.status]?.label ?? c.ticket.status}
                {c.ticket.qty ? ` · ${c.ticket.qty} sh` : ""}
                {c.ticket.cost !== undefined ? ` · ${usd(c.ticket.cost)}` : ""}
                {c.ticket.maxLoss !== undefined ? ` · max loss ${usd(c.ticket.maxLoss)}` : ""}
              </span>
            )}
            {rev && (
              <span className={`an-replay ${verdictOf ?? ""}`} title="The coach replayed this plan on the day's real 5-minute bars after the close">
                Replay: {OUTCOME[rev.outcome] ?? rev.outcome}
                {rev.outcome !== "not-triggered" && rev.outcome !== "no-data" ? ` ${rev.R >= 0 ? "+" : ""}${rev.R}R` : ""}
                {rev.triggeredAt ? ` · in ${rev.triggeredAt}${rev.exitAt ? `, out ${rev.exitAt}` : ""}` : ""}
                {verdictOf === "right" ? " · ✓ right call" : verdictOf === "missed" ? " · missed winner" : verdictOf === "wrong" ? " · ✗ loser" : ""}
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
