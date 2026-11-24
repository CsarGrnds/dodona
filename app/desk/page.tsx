"use client";
import { TodayMoney } from "@/components/TodayMoney";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentSessionView, AgentToolbox } from "@/components/AgentSessionView";
import { IbkrOrderPanel } from "@/components/IbkrOrderPanel";
import { TeamAnalysis } from "@/components/TeamAnalysis";
import { TradingFloor } from "@/components/TradingFloor";
import { NextRunCountdown, TeamRunStatus, startTeamRun } from "@/components/TeamRun";
import { ClaudeSessionView, TEAM_MODEL, TeamSessionView, type ClaudeSessionInfo } from "@/components/TeamSessionView";
import { DailyPnlChart, EquityChart, PnlCalendar, RDistribution, signedUsd } from "@/components/DeskCharts";
import { Brand, ChartCredit, Spinner } from "@/components/ui";
import { fmt } from "@/lib/client";
import type { DeskView } from "@/lib/data/deskView";
import type { AgentSession, JournalKind } from "@/lib/desk";
import type { RunReport } from "@/lib/data/deskRun";
import { getWatchlist } from "@/lib/store";

const AUTO_KEY = "dodona.desk.auto.v1";
const TAB_KEY = "dodona.desk.tab.v1";
type Tab = "today" | "session" | "positions" | "performance" | "journal";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "today", label: "Today · analysis & tickets" },
  { id: "session", label: "Team floor" },
  { id: "positions", label: "Positions" },
  { id: "performance", label: "Performance" },
  { id: "journal", label: "Journal & rules" },
];
// the practice ledger's own tabs: shown only in paper mode
const PRACTICE_TABS = new Set<Tab>(["positions", "performance", "journal"]);
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
const usd = (v?: number) => (v === undefined ? "—" : `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const tone = (v: number) => (v > 0 ? "up" : v < 0 ? "down" : "muted");
const nyTime = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const nyDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** The live batch can be built after the opening range forms, until 3 PM New York, weekdays. */
function inBatchWindow(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
  const m = Number(p.hour) * 60 + Number(p.minute);
  return !["Sat", "Sun"].includes(p.weekday) && m >= 9 * 60 + 46 && m <= 15 * 60;
}

export default function DeskPage() {
  const [d, setD] = useState<DeskView>();
  const [report, setReport] = useState<RunReport>();
  const [err, setErr] = useState<string>();
  const [running, setRunning] = useState(false);
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamTick, setTeamTick] = useState(0);
  const [auto, setAuto] = useState(false);
  const [chart, setChart] = useState<"equity" | "daily">("equity");
  const [feed, setFeed] = useState<"all" | "trades" | "claude">("all");
  const [tab, setTab] = useState<Tab>("today");
  useEffect(() => {
    try {
      const t = localStorage.getItem(TAB_KEY) as Tab | null;
      if (t && TABS.some((x) => x.id === t)) setTab(t);
    } catch {
      /* private window */
    }
  }, []);
  const pickTab = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* private window */
    }
  };
  const [, tick] = useState(0);
  const runningRef = useRef(false);
  const [live, setLive] = useState<AgentSession>();
  // "All Claude Code sessions": any session of this project on this machine, not only the trade team's
  const [allCc, setAllCc] = useState(false);
  // "Claude's session" folds away; the choice is remembered on this browser
  const [ccOpen, setCcOpen] = useState(true);
  useEffect(() => {
    try {
      setCcOpen(localStorage.getItem("dodona.claudeSessionOpen") !== "0");
    } catch {
      /* private window */
    }
  }, []);
  const toggleCc = () =>
    setCcOpen((o) => {
      try {
        localStorage.setItem("dodona.claudeSessionOpen", o ? "0" : "1");
      } catch {
        /* private window */
      }
      return !o;
    });
  const [ccList, setCcList] = useState<ClaudeSessionInfo[]>();
  const [ccPick, setCcPick] = useState<string>();
  const [ccErr, setCcErr] = useState<string>();
  useEffect(() => {
    try {
      setAllCc(localStorage.getItem("dodona.allClaudeSessions") === "1");
    } catch {
      /* private window */
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("dodona.allClaudeSessions", allCc ? "1" : "0");
    } catch {
      /* private window */
    }
    if (!allCc) return;
    let on = true;
    const load = () =>
      fetch("/api/claude/sessions", { cache: "no-store" })
        .then(async (r) => {
          const j = await r.json();
          if (!on) return;
          if (!r.ok) setCcErr(j.error ?? "Couldn't read Claude Code sessions.");
          else {
            setCcErr(undefined);
            setCcList(j.sessions);
          }
        })
        .catch(() => on && setCcErr("Couldn't read Claude Code sessions."));
    load();
    const id = setInterval(load, 15_000);
    return () => {
      on = false;
      clearInterval(id);
    };
  }, [allCc]);
  const [pick, setPick] = useState<string>();
  const [replay, setReplay] = useState(false); // the user asked for a past session while the floor is closed
  // a new team run takes over the floor, even from a past session someone was replaying
  const newest = d?.sessions?.[0]?.id;
  useEffect(() => {
    setPick(undefined);
    setReplay(false);
  }, [newest]);

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
    if (!auto || d?.practice === false) return; // practice cycles only in paper mode
    run();
    const id = setInterval(run, AUTO_MS);
    return () => clearInterval(id);
  }, [auto, run, d?.practice]);
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const poll = async () => {
      try {
        const j = await (await fetch("/api/desk/live", { cache: "no-store" })).json();
        if (j.session && Date.parse(j.session.startedAt) >= started - 5_000) setLive(j.session);
      } catch {
        /* keep polling */
      }
    };
    const id = setInterval(poll, 1_500);
    return () => clearInterval(id);
  }, [running]);
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
    if (feed === "claude") return j.filter((e) => e.by === "claude" || e.by === "team");
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
  // paper mode (Settings) decides what this page is: practice (fake money) or the real account
  const practice = d.practice !== false;
  const acct = d.account;
  const tabs = practice ? TABS : TABS.filter((x) => !PRACTICE_TABS.has(x.id));
  const saved = d.sessions ?? [];
  const shown: AgentSession | undefined = running && live ? live : saved.find((x) => x.id === pick) ?? saved[0];
  const ccShown = ccList?.find((x) => x.id === ccPick) ?? ccList?.[0];
  // the floor talks only while something is happening: market open, or a team run going (the 9:15
  // screen, the 4:10 review). Otherwise it's closed, until you pick a past session to replay.
  const teamLive = (running && !!live) || saved.some((x) => x.status === "running");
  // the floor only talks while a team run is going; between runs (market open or not) it's quiet
  const floorIdle = !teamLive && !replay;
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
          <Link className="btn ghost" href="/agents">Agents</Link>
          <Link className="btn ghost" href="/settings">Settings</Link>
        </div>
      </div>

      <TodayMoney />

      {/* ---- hero */}
      {practice && <div className="paper-watermark" aria-hidden>PAPER DESK</div>}
      <section className={`panel dk-hero ${practice ? (today ? (today.pnl >= 0 ? "green" : "red") : "") : acct ? (acct.unrealized >= 0 ? "green" : "red") : ""}`}>
        <div className="dk-hero-main">
          <div className="row" style={{ gap: 8 }}>
            {practice ? (
              <Link href="/settings" className="pill act" title="Paper mode is on (Settings): every number here is the practice account, fake money at real prices.">PAPER DESK · fake money</Link>
            ) : (
              <span className="pill bad" title="Paper mode is off (Settings): this is your real IBKR account.">Real money · IBKR</span>
            )}
            {d.realOrders?.on && practice && (
              <a href="#ibkr-orders" onClick={() => pickTab("today")} className={`pill ${d.realOrders.live ? "bad" : "ok"}`} title="Real orders go to Interactive Brokers from the IBKR orders panel below, only when you approve them.">
                {d.realOrders.live ? "LIVE orders · IBKR" : "IBKR paper orders"}
              </a>
            )}
            {d.realOrders?.on && d.realOrders.gateway && (
              <a
                href="https://localhost:5001"
                target="_blank"
                rel="noreferrer"
                className={`pill ${d.realOrders.gateway === "ready" ? "ok" : "bad"}`}
                title={d.realOrders.gateway === "ready" ? "The IBKR gateway is logged in." : "Click to open the gateway's login page (sign in, approve IBKR Mobile, wait for “Client login succeeds”). If it won't take, say “refresh IBKR” in Claude Code."}
              >
                {d.realOrders.gateway === "ready" ? "Gateway ✓ logged in" : d.realOrders.gateway === "login" ? "Gateway: LOG IN ↗" : "Gateway: DOWN"}
              </a>
            )}
            {d.driver === "team" ? (
              <span className="pill ok">✦ Claude Code trade team · /trade-desk</span>
            ) : (
              <span className={`pill ${d.agent.enabled ? "ok" : "care"}`}>{d.agent.enabled ? `✦ Claude trading · ${d.agent.model}` : "Rules engine trading"}</span>
            )}
            <span className={`pill ${d.market.open ? "ok" : ""}`}>{d.market.open ? "Market open" : `Market closed · ${d.market.reason}`}</span>
          </div>
          {!practice ? (
            acct ? (
              <div className="dk-today">
                <div>
                  <div className="muted small">Account value</div>
                  <div className="dk-big mono">{usd(acct.value)}</div>
                  <div className="small mono muted">{acct.positions} positions · synced {fmt.ago(acct.syncedAt)}</div>
                </div>
                <div>
                  <div className="muted small">Open P&amp;L</div>
                  <div className={`dk-big mono ${tone(acct.unrealized)}`}>{signedUsd(acct.unrealized)}</div>
                  <div className="small mono muted">on {usd(acct.invested)} invested</div>
                </div>
                <div>
                  <div className="muted small">Cash</div>
                  <div className="dk-mid mono">{usd(acct.cash)}</div>
                  <div className="small mono muted">team budget {usd(d.rules.budget)} · max loss {usd(d.rules.max_loss_per_trade_usd)}/trade</div>
                </div>
              </div>
            ) : (
              <div className="small muted">No IBKR sync yet: log in to the gateway (say “refresh IBKR” in Claude Code) and your real account shows here.</div>
            )
          ) : (
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
          )}
        </div>
      </section>

      {/* ---- orders waiting for the user's approval: top of the Desk on every tab, only when there's something to do */}
      {!practice && <IbkrOrderPanel />}

      {/* ---- the team's runs: its own card, apart from the account numbers */}
      <section className="panel dk-runs">
        <div className="dk-runs-head">
          <h2 style={{ margin: 0 }}>✦ Team runs</h2>
          <span className="spacer" />
          {practice && (
            <>
              <label className="dk-auto">
                <input type="checkbox" checked={auto} onChange={toggleAuto} /> {d.driver === "team" ? "Manage paper positions every 5 min" : "Auto every 5 min"}
              </label>
              <span className="muted small">
                Last practice run {fmt.ago(d.lastRunAt)}
                {nextRunIn !== undefined && !running ? ` · next in ${Math.ceil(nextRunIn / 60_000)}m` : ""}
              </span>
            </>
          )}
        </div>
        <div className="dk-hero-side">
          {!practice && !d.realOrders?.on ? (
            <div className="dk-window small muted">Real money, but sending orders to IBKR is off: turn on “Send orders to IBKR” in <Link href="/settings">Settings</Link> for the team to prepare batches.</div>
          ) : d.driver === "team" ? (
            <>
              {d.realOrders?.on && !inBatchWindow() && !teamBusy ? (
                <div className="dk-window small muted" title="The live run only prepares the IBKR batch inside this window; you approve it below.">
                  IBKR batch window: 9:46 AM–3 PM New York · the team prepares it then, you approve it
                </div>
              ) : (
              <button
                className="btn primary"
                disabled={teamBusy}
                title={d.realOrders?.on ? "Starts /trade-desk live in Claude Code: the team prepares today's IBKR batch for you to approve below. It places nothing." : "Starts /trade-desk in Claude Code: one paper cycle by the team."}
                onClick={async () => {
                  setTeamBusy(true);
                  const r = await startTeamRun(d.realOrders?.on ? "live" : "paper");
                  if (!r.ok) setErr(r.error);
                  setTeamBusy(false);
                  setTeamTick((x) => x + 1);
                }}
              >
                {teamBusy ? <Spinner /> : d.realOrders?.on ? "▶ Ask the team to look now" : "▶ Run a team cycle now"}
              </button>
              )}
              <div className="tr-card">
                {!!d.realOrders?.autoBatch?.length && <NextRunCountdown times={d.realOrders.autoBatch} watch={d.realOrders.watch} />}
                <TeamRunStatus tick={teamTick} />
              </div>
            </>
          ) : (
            <button className="btn primary" onClick={run} disabled={running}>{running ? <><Spinner /> Running desk…</> : "Run desk now"}</button>
          )}
        </div>
      </section>

      {!d.agent.enabled && d.driver !== "team" && (
        <div className="dk-banner">
          <b>Claude isn&apos;t connected yet</b>, so the rules engine is trading: it takes a setup only when that setup made money on that stock before. Add <code>ANTHROPIC_API_KEY</code> to <code>.env.local</code> and restart Dodona to let Claude read the charts and trade. Model: <code>{d.agent.model}</code> (change with <code>DODONA_DESK_MODEL</code>).
        </div>
      )}
      {err && <div className="err" style={{ marginTop: 12 }}>{err}</div>}

      <nav className="dk-tabs" aria-label="Desk sections">
        {tabs.map((x) => (
          <button key={x.id} className={tab === x.id || (x.id === "today" && !practice && PRACTICE_TABS.has(tab)) ? "on" : ""} onClick={() => pickTab(x.id)}>
            {x.label}
            {x.id === "positions" && d.positions.length > 0 && <span className="n">{d.positions.length}</span>}
          </button>
        ))}
      </nav>

      {(tab === "today" || (!practice && PRACTICE_TABS.has(tab))) && (
        <div className="dk-tab">
          {/* ---- every stock the team analyzed: its chart, the chartist's read, the verdict, its ticket */}
          <section className="panel">
            <div className="row" style={{ marginBottom: 4 }}>
              <h2 style={{ margin: 0 }}>✦ Team analysis</h2>
            </div>
            <div className="small muted" style={{ marginBottom: 12 }}>
              One card per stock the trade team looked at, grouped by run: the levels, the chart the chartist read (◫ Chart), the verdict and why, the ticket it became, and after the close the coach&apos;s replay on the real bars.
            </div>
            <TeamAnalysis tick={teamTick} />
          </section>
        </div>
      )}

      {tab === "session" && (
        <div className="dk-tab">
          {/* ---- the team on its trading floor, talking: replays the picked session, live while it runs */}
          {(shown?.model === TEAM_MODEL || (!shown && d.driver === "team")) && (
            <section className="panel">
              <div className="row" style={{ marginBottom: 8 }}>
                <h2 style={{ margin: 0 }}>✦ Trading floor</h2>
                <span className="spacer" />
                {floorIdle ? (
                  <span className="small muted">{d.market.open ? "Between runs" : `Closed · ${d.market.reason}`} · press Replay to watch the last session</span>
                ) : (
                  <>
                    <span className="small muted">{shown ? new Date(shown.startedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</span>
                    {replay && !teamLive && <button className="btn ghost" onClick={() => { setReplay(false); setPick(undefined); }}>Close replay</button>}
                  </>
                )}
              </div>
              <TradingFloor
                session={shown?.id}
                idle={floorIdle ? { title: d.market.open ? "Between runs" : `Market closed · ${d.market.reason}`, note: d.market.open ? "No team run is going right now, so the floor is on a break. The team's real messages show here as soon as the next run starts." : "No team run is going, so the floor is off the clock. The team's real messages come back with the next run.", onReplay: saved.length ? () => setReplay(true) : undefined } : undefined}
              />
            </section>
          )}
          <section className="panel" style={{ marginTop: 14 }}>
            <div className="row" style={{ marginBottom: ccOpen ? 10 : 0 }}>
              <button className="cc-fold" onClick={toggleCc} aria-expanded={ccOpen} title={ccOpen ? "Collapse" : "Expand"}>
                <span className={`cc-caret${ccOpen ? " open" : ""}`}>▸</span>
                <h2 style={{ margin: 0 }}>✦ Claude&apos;s session</h2>
              </button>
              <span className="spacer" />
              {ccOpen && (<>
              <label className="small muted" style={{ display: "inline-flex", gap: 6, alignItems: "center", marginRight: 8 }} title="Show any Claude Code session of this project on this computer (this one included), not only the trade team's">
                <input type="checkbox" checked={allCc} onChange={() => setAllCc(!allCc)} /> All Claude Code sessions
              </label>
              {allCc && ccList && ccList.length > 0 && (
                <select className="as-pick" value={ccShown?.id} onChange={(e) => setCcPick(e.target.value)}>
                  {ccList.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.live ? "● " : ""}
                      {new Date(x.updatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {x.title.slice(0, 50)}
                      {x.subagents ? ` · ${x.subagents} subagents` : ""}
                    </option>
                  ))}
                </select>
              )}
              {!allCc && saved.length > 1 && !(running && live) && (
                <select className="as-pick" value={shown?.id} onChange={(e) => { setPick(e.target.value); setReplay(true); }}>
                  {saved.map((x) => (
                    <option key={x.id} value={x.id}>
                      {new Date(x.startedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {x.model === TEAM_MODEL ? "trade team" : `${x.toolCalls} tools`} · {x.status}
                    </option>
                  ))}
                </select>
              )}
              </>)}
            </div>
            {!ccOpen ? null : allCc ? (
              ccErr ? (
                <div className="err">{ccErr}</div>
              ) : !ccList ? (
                <div className="muted small"><Spinner /> Reading Claude Code sessions…</div>
              ) : !ccShown ? (
                <div className="dk-empty">No Claude Code sessions for this project on this computer yet.</div>
              ) : (
                <>
                  <div className="small muted" style={{ marginBottom: 8 }}>
                    Read from this computer&apos;s Claude Code transcripts. Sessions that ran in the cloud (claude.ai/code) keep their logs there, so they don&apos;t show here.
                  </div>
                  <ClaudeSessionView key={ccShown.id} info={ccShown} />
                </>
              )
            ) : shown?.model === TEAM_MODEL ? (
              <TeamSessionView session={shown} onLive={load} />
            ) : shown ? (
              <AgentSessionView session={shown} live={running && !!live} />
            ) : (
              <>
                <div className="small muted" style={{ marginBottom: 10 }}>
                  Run <code>/trade-desk</code> in Claude Code to start the trade team (a lead trader and 8 specialists using the real /trader-* skills, Time Machine included); its session shows here live. Or let Dodona&apos;s own desk trade with the button above.{" "}
                  {d.agent.enabled
                    ? "No session yet. Claude runs when there's a new setup or an open position to review, while the market is open. Every step it takes will show here live: its reasoning, each tool call with what came back, and the decision."
                    : "Once Claude is connected, every session shows here live: its reasoning, each tool it calls with what came back, and the decision. These are the tools it can use; all of them only read data:"}
                </div>
                <AgentToolbox />
              </>
            )}
          </section>
        </div>
      )}

      {tab === "positions" && practice && (
        <div className="dk-tab">
          <section className="panel">
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
                      <span className="muted small">{p.setup} · {p.by === "team" ? "✦ Team" : p.by === "claude" ? "✦ Claude" : "Rules"}</span>
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
          </section>
        {report && (
          <section className="panel">
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
        </div>
      )}

      {tab === "performance" && practice && (
        <div className="dk-tab">
        <section className="dk-tiles" style={{ marginTop: 0 }}>
          <Tile label="Win rate" value={st.trades ? `${Math.round(st.winRate * 100)}%` : "—"} sub={`${st.trades} closed trade${st.trades === 1 ? "" : "s"}`} />
          <Tile label="Profit factor" value={st.profitFactor !== undefined ? st.profitFactor.toFixed(2) : "—"} sub="won ÷ lost, over 1 = profitable" cls={st.profitFactor === undefined ? "" : st.profitFactor >= 1 ? "up" : "down"} />
          <Tile label="Per trade" value={st.trades ? signedUsd(st.expectancy) : "—"} sub={st.trades ? `${st.avgR >= 0 ? "+" : ""}${st.avgR}R average` : "expectancy"} cls={tone(st.expectancy)} />
          <Tile label="Avg win · loss" value={st.trades ? `${st.avgWin ? usd(st.avgWin) : "—"} · ${st.avgLoss ? usd(Math.abs(st.avgLoss)) : "—"}` : "—"} sub="after fees" />
          <Tile label="Green · red days" value={`${st.greenDays} · ${st.redDays}`} sub={st.bestDay ? `best ${signedUsd(st.bestDay.pnl)}${st.worstDay ? `, worst ${signedUsd(st.worstDay.pnl)}` : ""}` : "no days yet"} />
          <Tile label="Max drawdown" value={fmt.pct(st.maxDrawdown, 1)} sub="peak to low, end of day" cls={st.maxDrawdown < -0.1 ? "down" : ""} />
          <Tile label="Streak" value={st.streak.kind === "none" ? "—" : `${st.streak.n} ${st.streak.kind === "win" ? "win" : "loss"}${st.streak.n === 1 ? "" : st.streak.kind === "win" ? "s" : "es"}`} sub={`fees ${usd(st.fees)}`} cls={st.streak.kind === "win" ? "up" : st.streak.kind === "loss" ? "down" : ""} />
        </section>
        <section className="grid two">
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
          <section className="grid two">
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
            </div>
            <div className="panel">
            <h2>Who traded</h2>
            <div className="dk-setups">
              {(["team", "claude", "rules"] as const).map((k) => (
                <div key={k} className="row small">
                  <span>{k === "team" ? "✦ Trade team" : k === "claude" ? "✦ Claude" : "Rules engine"}</span>
                  <span className="spacer" />
                  <span className="muted">{st.byAgent[k].trades} trades</span>
                  <b className={`mono ${tone(st.byAgent[k].pnl)}`}>{signedUsd(st.byAgent[k].pnl)}</b>
                </div>
              ))}
            </div>
            </div>
          </section>
        <section className="panel">
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
                      <td className="small">{t.by === "team" ? "✦ Team" : t.by === "claude" ? "✦ Claude" : "Rules"}</td>
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
        </div>
      )}

      {tab === "journal" && practice && (
        <div className="dk-tab">
          <section className="grid two">
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
                      <div className="small muted">{nyDate(e.at)} {nyTime(e.at)} · {e.by === "team" ? "✦ Team" : e.by === "claude" ? "✦ Claude" : e.by === "rules" ? "Rules" : "Desk"}</div>
                      <div className="small">{e.text}</div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
            <div className="panel">
            <h2>Rules (trader/config.json)</h2>
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
        </div>
      )}


      <p className="disclaimer">
        {practice
          ? "Paper mode: practice with fake money; nothing here is sent to a broker. Fills are simulated from Yahoo's delayed 5-minute bars with 0.05% slippage and a $0.35 commission each way; a real stop can fill worse in a fast market. Past practice results don't promise future ones. Not financial advice. "
          : "Real money: the team only prepares IBKR batches; an order is placed only when you approve it here. A stop is an order, not a promise: a gap can fill below it. Day trading loses most people money. Not financial advice. "}
        <ChartCredit />
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
