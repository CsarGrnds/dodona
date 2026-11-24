"use client";
// The latest trading session in facts: what the screener kept, every stock the team looked at and
// what it decided (and why), how the coach graded it after the close, and the real IBKR orders.
import { useEffect, useState } from "react";
import Link from "next/link";
import { fitLine } from "@/lib/budget";
import type { SessionPick, SessionSummary } from "@/lib/session";

const nyTime = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
const dayLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const r = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}R`;

const list = (m: Record<string, number>) =>
  Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([why, n]) => `${n} ${why.replace("x% under", "too far under")}`)
    .join(", ");

const OUTCOME: Record<string, string> = { target: "hit target", stop: "hit stop", close: "sold at close", "not-triggered": "never triggered", "no-data": "no bars" };

function outcome(p: SessionPick) {
  if (!p.outcome) return <span className="muted">review after close</span>;
  const cls = p.rightCall === true ? "up" : p.rightCall === false ? "down" : "muted";
  return (
    <span className={cls}>
      {p.verdict === "skip" && p.outcome !== "not-triggered" && p.outcome !== "no-data" ? "would have " : ""}
      {OUTCOME[p.outcome] ?? p.outcome}
      {p.outcome !== "not-triggered" && p.outcome !== "no-data" && p.R !== undefined ? ` · ${r(p.R)}` : ""}
      {p.rightCall === true ? " ✓" : p.rightCall === false ? " ✗" : ""}
    </span>
  );
}

export function SessionCard({ tick }: { tick: number }) {
  const [s, setS] = useState<SessionSummary | null>();
  useEffect(() => {
    fetch("/api/desk/session", { cache: "no-store" })
      .then((x) => (x.ok ? x.json() : null))
      .then(setS)
      .catch(() => setS(null));
  }, [tick]);
  if (!s) return null;

  const takes = s.picks.filter((p) => p.verdict === "take").length;
  const real = s.orders.filter((o) => o.kind !== "stop");
  return (
    <div className="ss">
      <div className="ss-head">
        <b>Session · {dayLabel(s.date)}</b>
        <span className="muted">
          {s.shortlist ? `${s.shortlist.kept} on the shortlist${s.shortlist.universe ? ` of ${s.shortlist.universe.toLocaleString()}` : ""}` : "no shortlist"}
          {s.shortlist?.spyReturn20 !== undefined ? ` · SPY 20d ${s.shortlist.spyReturn20 > 0 ? "+" : ""}${s.shortlist.spyReturn20.toFixed(1)}%` : ""}
          {` · ${s.scans.length} scan${s.scans.length === 1 ? "" : "s"} · ${s.picks.length} with a trade plan · ${takes} taken · ${real.length} new trade${real.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {s.picks.length > 0 ? (
        <div className="ss-scroll">
          <table className="ss-table">
            <thead>
              <tr>
                <th>NY time</th>
                <th>Stock</th>
                <th>Setup</th>
                <th>Chart</th>
                <th>Market</th>
                <th>Plan (trigger / stop / target)</th>
                <th>Decision</th>
                <th>What happened</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {s.picks.map((p) => (
                <tr key={`${p.symbol}@${p.at}`}>
                  <td className="mono">{nyTime(p.at)}</td>
                  <td><b>{p.symbol}</b></td>
                  <td>{p.setup.toUpperCase()}</td>
                  <td className="mono">{p.chartScore ? `${p.chartScore}/5` : "—"}</td>
                  <td>{p.marketMode ?? "—"}</td>
                  <td className="mono">{p.trigger} / {p.stop} / {p.target}</td>
                  <td><span className={`ss-verdict ${p.verdict}`}>{p.verdict === "take" ? "TAKE" : "SKIP"}</span></td>
                  <td>{outcome(p)}</td>
                  <td className="ss-why" title={p.why}>{p.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : s.scans.length === 0 ? (
        <div className="muted small">No run has scanned the shortlist yet today.</div>
      ) : null}

      {s.scans.length > 0 && (
        <div className="ss-scans">
          <div className="small muted">What each run found: a trade needs an opening range that has formed and not broken yet, so its buy-stop can wait at IBKR.</div>
          {s.scans.map((x) => (
            <div key={x.at} className="ss-scan small">
              <span className="mono">{nyTime(x.at)}</span>
              <span>
                {x.universe} {x.source === "shortlist" ? "shortlisted" : "market"} names
                {x.early && Object.keys(x.early).length > 0 && <> · out early: {list(x.early)}</>}
                {x.checked > 0 && <> · {x.checked} checked closely{Object.keys(x.rejected).length > 0 && <>: {list(x.rejected)}</>}</>}
              </span>
              <b className={x.ready.length ? "up" : "muted"}>{x.ready.length ? `ready: ${x.ready.join(", ")}` : "none ready"}</b>
            </div>
          ))}
        </div>
      )}

      {s.noTrade && (
        <div className="ss-line ss-why-none">
          <b>Why no trade:</b>
          {s.noTrade.map((x) => <div key={x}>{x}</div>)}
        </div>
      )}
      {s.fit && s.fit.strategies.some((x) => x.built && x.verdict !== "fits") && (
        <div className="ss-line ss-fit">
          <b>Your budget (${s.fit.budget.toLocaleString()}):</b>{" "}
          {s.fit.strategies.map((x) => (
            <div key={x.id} className={x.verdict === "fits" ? "up" : x.verdict === "tight" ? "" : "down"}>
              {fitLine(x)}
              {!x.built && <span className="muted"> Not available to the team yet.</span>}
            </div>
          ))}
          <div className="muted small">Fees only, not whether a strategy makes money. <Link href="/settings">Settings → Limits from the budget</Link></div>
        </div>
      )}

      {s.review && (
        <div className="ss-line">
          <b>Coach:</b> {s.review.right} of {s.review.graded} calls right · {s.review.triggered} of {s.picks.length} would have triggered
          {s.review.skipR !== 0 && <> · skips {s.review.skipR < 0 ? `avoided ${r(s.review.skipR)}` : `missed ${r(s.review.skipR)}`}</>}
          {takes > 0 && <> · takes {r(s.review.takeR)}</>}
        </div>
      )}
      {s.track && (
        <div className="ss-line ss-track" title="The grade is the share of right calls across every session the coach reviewed: A 85%+, B 70%+, C 55%+, else D. A right call is a take that made money, or a skip that would have lost or never triggered. It grades decisions; money only shows once the team takes trades.">
          <span className={`ss-grade g${s.track.grade}`}>{s.track.grade}</span>
          <span>
            <b>Team rating:</b> {s.track.right} of {s.track.graded} calls right ({s.track.pct}%) over {s.track.sessions} session{s.track.sessions === 1 ? "" : "s"}
            {" · "}
            {s.track.takes ? <>{s.track.takes} trade{s.track.takes === 1 ? "" : "s"} taken, <span className={s.track.takeR >= 0 ? "up" : "down"}>{r(s.track.takeR)}</span></> : <span className="muted">no trades taken yet, so no profit or loss to grade</span>}
            {s.track.avoided > 0 && <> · {s.track.avoided} losers avoided ({r(s.track.avoidedR)})</>}
            {s.track.passedUp > 0 && <> · <span className="down">{s.track.passedUp} winner{s.track.passedUp === 1 ? "" : "s"} passed up ({r(s.track.passedUpR)})</span></>}
          </span>
        </div>
      )}
    </div>
  );
}
