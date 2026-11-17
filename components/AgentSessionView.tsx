"use client";
// What Claude did behind the scenes in one desk session: its reasoning, every tool call with what
// came back, and the decision. Live while a run is going, saved afterwards.
import { Spinner } from "@/components/ui";
import type { AgentSession, SessionStep } from "@/lib/desk";

export const TOOL_INFO: Array<{ name: string; label: string; what: string }> = [
  { name: "get_market_overview", label: "Market & sectors", what: "SPY trend, today's move for SPY, QQQ, IWM and 12 sector ETFs" },
  { name: "get_daily_chart", label: "Daily chart", what: "Up to 250 daily candles plus today so far" },
  { name: "get_intraday_chart", label: "Intraday chart", what: "5/15/30-minute bars, opening range, VWAP" },
  { name: "get_levels_and_indicators", label: "Levels & indicators", what: "Support/resistance, moving averages, RSI, MACD, ATR, relative strength" },
  { name: "get_setup_track_record", label: "Setup track record", what: "How each setup did on this stock before" },
  { name: "get_news_and_events", label: "News & earnings", what: "Headlines, next earnings date, sector, analysts" },
  { name: "get_desk_history", label: "Desk history", what: "This desk's own closed trades and what worked" },
];

const ICON: Record<SessionStep["kind"], string> = { thinking: "✦", tool: "⌁", text: "✎", decision: "✓", error: "!" };
const secs = (a: string, b?: string) => Math.max(0, ((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000);
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function AgentSessionView({ session, live }: { session: AgentSession; live?: boolean }) {
  const running = session.status === "running";
  const steps = [...session.steps].reverse();
  return (
    <div className="as">
      <div className="as-head">
        <span className={`pill ${running ? "act" : session.status === "done" ? "ok" : "bad"}`}>{running ? <><Spinner /> {live ? "Live" : "Running"}</> : session.status === "done" ? "Done" : "Failed"}</span>
        <span className="small">{session.trigger || "Desk check"}</span>
        <span className="spacer" />
        <span className="muted small mono">
          {session.model} · {session.rounds} round{session.rounds === 1 ? "" : "s"} · {session.toolCalls} tool call{session.toolCalls === 1 ? "" : "s"} · {k(session.usage.input + session.usage.cacheRead)} in / {k(session.usage.output)} out tokens · {secs(session.startedAt, session.endedAt).toFixed(0)}s
        </span>
      </div>
      {session.error && <div className="err small">{session.error}</div>}
      {steps.length === 0 ? (
        <div className="dk-empty">{running ? "Claude is reading the brief…" : "No steps recorded."}</div>
      ) : (
        <ol className="as-steps">
          {steps.map((st, i) => (
            <li key={`${st.at}-${i}`} className={`as-step ${st.kind} ${st.ok === false ? "fail" : ""}`}>
              <span className="as-icon">{ICON[st.kind]}</span>
              <details open={st.kind === "decision" || st.kind === "thinking" ? i < 3 : false}>
                <summary>
                  <b>{st.title}</b>
                  {st.ms !== undefined && <span className="muted small mono"> {st.ms} ms</span>}
                  <span className="muted small"> · {new Date(st.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>
                </summary>
                {st.input && Object.keys(st.input).length > 0 && <div className="as-input mono small">{JSON.stringify(st.input)}</div>}
                {st.detail && <div className={`as-detail small ${st.kind === "tool" ? "mono" : ""}`}>{st.detail}</div>}
              </details>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Shown before Claude has run: the tools it will use. */
export function AgentToolbox() {
  return (
    <div className="as-tools">
      {TOOL_INFO.map((t) => (
        <div key={t.name} className="as-tool">
          <b className="small">⌁ {t.label}</b>
          <span className="muted small">{t.what}</span>
        </div>
      ))}
    </div>
  );
}
