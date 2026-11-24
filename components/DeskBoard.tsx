"use client";
// The standing team's board: what the scout sees on every shortlisted stock right now, the team's call
// on each, and what the scout is waiting for before it wakes the team again. Below it, the strategist's
// latest research: every strategy in the roster, replayed without hindsight, after IBKR's fees.
import { useEffect, useState } from "react";
import type { Board, BoardRow } from "@/lib/board";
import type { StrategyStats } from "@/lib/strategies";

interface Research {
  ranAt: string;
  sessions: { from: string; to: string; count: number };
  budget: number;
  strategies: StrategyStats[];
  caveats: string[];
  report?: string;
}

const clock = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : "");
const r = (x?: number) => (x === undefined ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`);
const STATE_PILL: Record<BoardRow["state"], string> = { ready: "act", "broke out": "care", "not ready": "", out: "" };

function teamCell(x: BoardRow) {
  if (!x.decision) {
    if (!x.lastWorked) return <span className="muted">—</span>;
    const recent = Date.now() - Date.parse(x.lastWorked) < 20 * 60_000;
    return <span className="muted" title={`The team was woken for it at ${clock(x.lastWorked)} ET`}>{recent ? "working…" : "looked at, no call logged"}</span>;
  }
  const d = x.decision;
  return (
    <span title={d.why}>
      <span className={`pill ${d.verdict === "take" ? "ok" : ""}`}>{d.verdict}</span>{" "}
      {d.chartScore !== undefined && <span className="muted">chart {d.chartScore} · </span>}
      <span className="muted">{clock(d.at)}</span>
      {x.watchingFor && <div className="small" style={{ color: "var(--accent)" }}>↻ waiting for {x.watchingFor}</div>}
      {!!x.rechecks && <div className="small muted">re-checked {x.rechecks}×</div>}
    </span>
  );
}

export function DeskBoard({ tick }: { tick?: number }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [research, setResearch] = useState<Research | null>(null);
  const [all, setAll] = useState(false);
  const [showReport, setShowReport] = useState(false);
  useEffect(() => {
    let on = true;
    const load = () =>
      fetch("/api/desk/board", { cache: "no-store" })
        .then((x) => x.json())
        .then((j) => on && (setBoard(j.board ?? null), setResearch(j.research ?? null)))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 60_000);
    return () => ((on = false), clearInterval(t));
  }, [tick]);

  const rows = board?.rows ?? [];
  const shown = all ? rows : rows.filter((x) => x.state === "ready" || x.decision || x.lastWorked);
  const count = (s: BoardRow["state"]) => rows.filter((x) => x.state === s).length;
  const live = research?.strategies.find((s) => s.live);
  const best = research?.strategies[0];

  return (
    <>
      <section className="panel">
        <div className="row" style={{ marginBottom: 4, gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>✦ The board</h2>
          {board && (
            <span className="small muted">
              Scout&apos;s last look {clock(board.at)} ET · {count("ready")} ready · {count("broke out")} broke out · {count("not ready")} not ready
              {board.market && ` · SPY ${board.market.spy} ${board.market.aboveVwap ? "above" : "below"} VWAP ${board.market.vwap}`}
            </span>
          )}
          <span className="spacer" />
          {rows.length > 0 && (
            <label className="small muted" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All {rows.length}
            </label>
          )}
        </div>
        <div className="small muted" style={{ marginBottom: 10 }}>
          The scout (Dodona&apos;s code, no tokens) checks every shortlisted stock on each look and wakes the team only for a range that&apos;s ready and new, or for a skip whose reasons have cleared (↻).
        </div>
        {!board ? (
          <div className="dk-empty">No board yet today. The scout starts at 9:46 AM New York when “Prepare the batch by itself” and “Look for trades every” are on.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Stock</th>
                  <th>State</th>
                  <th>Price</th>
                  <th>Trigger</th>
                  <th>Rel. volume</th>
                  <th>Scout</th>
                  <th>Team</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((x) => (
                  <tr key={x.symbol}>
                    <td><b>{x.symbol}</b></td>
                    <td><span className={`pill ${STATE_PILL[x.state]}`}>{x.state}</span></td>
                    <td>{x.price?.toFixed(2) ?? "—"}</td>
                    <td>{x.orHigh?.toFixed(2) ?? "—"}</td>
                    <td style={{ color: x.relVolume === undefined ? undefined : x.relVolume >= 1 ? "var(--buy)" : "var(--muted)" }}>{x.relVolume?.toFixed(2) ?? "—"}</td>
                    <td className="small muted">{x.note}</td>
                    <td className="small">{teamCell(x)}</td>
                  </tr>
                ))}
                {!shown.length && (
                  <tr>
                    <td colSpan={7} className="muted small">Nothing ready and no calls yet on this look. Tick “All” to see every stock and why.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="row" style={{ marginBottom: 4, gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>∑ Strategy research</h2>
          {research && (
            <span className="small muted">
              {research.sessions.count} sessions ({research.sessions.from} to {research.sessions.to}) · at ${research.budget} · run {new Date(research.ranAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </span>
          )}
        </div>
        {!research ? (
          <div className="dk-empty">No research yet. The strategist runs every Saturday from 10 AM New York while Dodona runs, or ask Claude for <code>/trade-desk research</code>.</div>
        ) : (
          <>
            <div className="small muted" style={{ marginBottom: 10 }}>
              Every strategy replayed on each morning&apos;s shortlist without hindsight, then IBKR&apos;s fees at your budget. Only an “edge” is evidence; the team trades only what you turn on.
              {best && live && (
                <>
                  {" "}Best: <b>{best.label}</b> ({best.verdict}). The team trades <b>{live.label}</b> ({live.verdict}).
                </>
              )}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th>Trades</th>
                    <th title="Average result per trade before fees, with its 95% range">Before fees</th>
                    <th title="Average after IBKR's fees, sized at your budget">At ${research.budget}</th>
                    <th>At $5k</th>
                    <th>Win</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {research.strategies.map((s) => (
                    <tr key={s.id} title={s.rule}>
                      <td>
                        <b>{s.label}</b>
                        {s.live && <span className="pill act" style={{ marginLeft: 6 }}>traded now</span>}
                      </td>
                      <td>{s.trades}</td>
                      <td>
                        {r(s.grossR)} <span className="muted small">±{s.ci95.toFixed(2)}</span>
                      </td>
                      <td style={{ color: (s.netAtBudget ?? 0) > 0 ? "var(--buy)" : "var(--sell)" }}>{r(s.netAtBudget)}</td>
                      <td style={{ color: (s.netAt5k ?? 0) > 0 ? "var(--buy)" : "var(--sell)" }}>{r(s.netAt5k)}</td>
                      <td>{s.winPct}%</td>
                      <td title={s.why}>
                        <span className={`pill ${s.verdict === "edge" ? "ok" : s.verdict === "maybe" ? "care" : s.verdict === "no edge" ? "bad" : ""}`}>{s.verdict}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {research.caveats.length > 0 && <div className="small muted" style={{ marginTop: 8 }}>{research.caveats.join(" ")}</div>}
            {research.report && (
              <div style={{ marginTop: 10 }}>
                <button className="btn ghost" onClick={() => setShowReport((x) => !x)}>{showReport ? "Hide" : "Read"} the strategist&apos;s report</button>
                {showReport && <pre className="small" style={{ whiteSpace: "pre-wrap", marginTop: 8, fontFamily: "inherit" }}>{research.report}</pre>}
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}
