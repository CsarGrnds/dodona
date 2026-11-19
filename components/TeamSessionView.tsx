"use client";
// The Claude Code trade team's session (/trade-desk): the lead, each specialist subagent, the
// skills they ran, what came back, and the verdicts they logged. Live while the session runs.
import { useEffect, useMemo, useState } from "react";
import { Spinner } from "@/components/ui";
import type { AgentSession } from "@/lib/desk";
import type { AgentUsage, TeamStep, TeamTranscript } from "@/lib/data/transcripts";

export const TEAM_MODEL = "Claude Code trade team";

const ROLE: Record<string, { label: string; icon: string; skill?: string }> = {
  lead: { label: "Lead trader", icon: "✦" },
  "trade-screener": { label: "Screener", icon: "☰", skill: "trader-news" },
  "trade-scanner": { label: "Scanner", icon: "⌕", skill: "trader-scanner" },
  "trade-news": { label: "News", icon: "✉", skill: "trader-news" },
  "trade-entry": { label: "Entry", icon: "↗", skill: "trader-entry" },
  "trade-exit": { label: "Exit plan", icon: "⇥", skill: "trader-exit" },
  "trade-timemachine": { label: "Time Machine", icon: "⧖", skill: "trader-timemachine" },
  "trade-analyst": { label: "Analyst", icon: "▤", skill: "trader-analyst" },
  "trade-budget": { label: "Budget", icon: "$", skill: "trader-budget" },
  "trade-risk": { label: "Risk", icon: "⛨", skill: "trader-risk" },
  "trade-chartist": { label: "Chartist", icon: "◫" },
  "trade-coach": { label: "Coach", icon: "✎" },
};
const roleOf = (a: string) => ROLE[a] ?? ROLE[`trade-${a}`] ?? { label: a, icon: "•" };
const keyOf = (a: string) => (ROLE[a] ? a : ROLE[`trade-${a}`] ? `trade-${a}` : a);
/** "claude-haiku-5-5" / "haiku" → "Haiku 5.5" / "Haiku"; "inherit" → the session's model. */
const modelName = (m?: string) => {
  if (!m) return undefined;
  if (m === "inherit") return "session model";
  const x = m.replace(/^claude-/, "").match(/^([a-z]+)(?:-(\d+)-(\d+))?/);
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)}${x[2] ? ` ${x[2]}.${x[3]}` : ""}` : m;
};
const usd = (n: number) => (n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
const usageTip = (u: AgentUsage) =>
  `${u.calls} model calls · ${tok(u.input + u.cacheRead + u.cacheWrite)} input (${tok(u.cacheRead)} cached) · ${tok(u.output)} output${u.costUsd !== undefined ? ` · about ${usd(u.costUsd)} at API prices` : ""}`;
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

interface Row extends TeamStep {
  logged?: boolean; // a verdict the team wrote to the ledger with `npm run desk -- log`
}
const NONE: Row[] = [];

/** A transcript with a roster: the lead (or main session) and each subagent, their model, steps and cost. */
function TranscriptView({ tx, models = {}, logged = NONE, roster, leadLabel = ROLE.lead.label, status, label, summary, empty }: {
  tx?: TeamTranscript;
  models?: Record<string, string>;
  logged?: Row[];
  roster: string[];
  leadLabel?: string;
  status: "live" | "done" | "stopped";
  label?: string;
  summary?: string;
  empty: string;
}) {
  const [only, setOnly] = useState<string>();
  const [raw, setRaw] = useState(false);
  const role = (a: string) => (a === "lead" ? { ...ROLE.lead, label: leadLabel } : roleOf(a));

  const rows: Row[] = useMemo(() => {
    const all = [...logged, ...(raw ? tx?.steps ?? [] : (tx?.steps ?? []).filter((s) => s.kind !== "output" || s.ok === false))].map((r) => ({ ...r, agent: keyOf(r.agent) }));
    return all.filter((r) => !only || r.agent === only).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }, [logged, tx, only, raw]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of [...logged.map((s) => s.agent), ...(tx?.steps ?? []).map((s) => keyOf(s.agent))]) m.set(r, (m.get(r) ?? 0) + 1);
    return m;
  }, [logged, tx]);

  const usage = useMemo(() => new Map((tx?.agents ?? []).filter((a) => a.usage).map((a) => [keyOf(a.agent), a.usage!])), [tx]);

  return (
    <div className="as">
      <div className="as-head">
        <span className={`pill ${status === "live" ? "act" : status === "done" ? "ok" : "bad"}`}>{status === "live" ? <><Spinner /> Live</> : status === "done" ? "Done" : "Stopped"}</span>
        {label && <span className="small">{label}</span>}
        <span className="spacer" />
        {tx?.costUsd !== undefined && (
          <span className="small muted" title="What these tokens would cost through the Claude API. In Claude Code they count against your plan's usage instead.">
            ≈ {usd(tx.costUsd)} at API prices
          </span>
        )}
        <label className="small muted" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={raw} onChange={() => setRaw(!raw)} /> Every command output
        </label>
      </div>
      <div className="tm-roster">
        {roster.map((k) => {
          const r = role(k);
          const u = usage.get(k);
          const model = modelName(u?.model ?? (k === "lead" ? "inherit" : models[k]));
          return (
            <button
              key={k}
              className={`tm-member ${only === k ? "on" : ""} ${counts.get(k) ? "active" : ""}`}
              onClick={() => setOnly(only === k ? undefined : k)}
              title={[r.skill ? `/${r.skill}` : k === "lead" ? "the main session" : `subagent ${k}`, model && `model: ${model}`, u && usageTip(u)].filter(Boolean).join("\n")}
            >
              <span className="tm-icon">{r.icon}</span>
              <span>{r.label}</span>
              {model && <span className="tm-model">{model}</span>}
              <span className="muted mono">{counts.get(k) ?? 0}</span>
              {u?.costUsd !== undefined && <span className="muted mono">{usd(u.costUsd)}</span>}
            </button>
          );
        })}
      </div>
      {summary && <div className="dk-read"><span className="dk-read-icon">✦</span><div>{summary}</div></div>}
      {tx?.note && <div className="small muted">{tx.note}</div>}
      {rows.length === 0 ? (
        <div className="dk-empty">{empty}</div>
      ) : (
        <ol className="as-steps">
          {rows.map((r, i) => {
            const who = role(r.agent);
            return (
              <li key={`${r.at}-${i}`} className={`as-step tm-${r.kind} ${r.ok === false ? "fail" : ""} ${r.logged ? "logged" : ""}`}>
                <span className="as-icon" title={who.label}>{who.icon}</span>
                <details open={r.logged || r.kind === "report" ? i < 6 : false}>
                  <summary>
                    <span className="tm-who">{who.label}</span> <b>{r.title}</b>
                    {r.logged && <span className="pill ok" style={{ marginLeft: 6 }}>verdict</span>}
                    <span className="muted small"> · {time(r.at)}</span>
                  </summary>
                  {r.detail && <div className={`as-detail small ${r.kind === "command" || r.kind === "skill" || r.kind === "output" ? "mono" : ""}`}>{r.detail}</div>}
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** Poll a JSON endpoint while `live`; keep the last good answer on errors. */
function usePoll<T>(url: string | undefined, live: boolean, ms: number): T | undefined {
  const [data, setData] = useState<T>();
  useEffect(() => {
    if (!url) return;
    let on = true;
    const load = async () => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        const j = await r.json();
        if (on) setData(j);
      } catch {
        /* keep the last view */
      }
    };
    load();
    if (!live) return () => void (on = false);
    const id = setInterval(load, ms);
    return () => {
      on = false;
      clearInterval(id);
    };
  }, [url, live, ms]);
  return data;
}

export function TeamSessionView({ session, onLive }: { session: AgentSession; onLive?: () => void }) {
  const j = usePoll<{ session?: AgentSession; transcript?: TeamTranscript; models?: Record<string, string> }>(`/api/desk/team?session=${encodeURIComponent(session.id)}`, session.status === "running", 3_000);
  const sess = j?.session ?? session;
  useEffect(() => {
    if (j?.session && j.session.status !== "running" && session.status === "running") onLive?.();
  }, [j?.session, session.status, onLive]);
  const logged: Row[] = useMemo(() => sess.steps.map((s) => ({ at: s.at, agent: keyOf(s.agent ?? "lead"), kind: s.kind === "decision" ? "report" : "text", title: s.title, detail: s.detail, logged: true })), [sess.steps]);
  const running = sess.status === "running";
  return (
    <TranscriptView
      tx={j?.transcript}
      models={j?.models}
      logged={logged}
      roster={Object.keys(ROLE)}
      status={running ? "live" : sess.status === "done" ? "done" : "stopped"}
      label={sess.trigger}
      summary={sess.summary}
      empty={running ? "The team is starting…" : "No steps recorded for this session."}
    />
  );
}

export interface ClaudeSessionInfo {
  id: string;
  title: string;
  startedAt?: string;
  updatedAt: string;
  sizeKb: number;
  subagents: number;
  live: boolean;
}

/** Any Claude Code session of this project on this machine: the main session and every subagent it sent out. */
export function ClaudeSessionView({ info }: { info: ClaudeSessionInfo }) {
  const j = usePoll<{ transcript?: TeamTranscript & { live: boolean }; error?: string }>(`/api/claude/sessions/${info.id}`, info.live, 4_000);
  const tx = j?.transcript;
  const live = tx?.live ?? info.live;
  const roster = useMemo(() => ["lead", ...(tx?.agents ?? []).map((a) => keyOf(a.agent)).filter((a) => a !== "lead")], [tx]);
  if (j?.error) return <div className="err">{j.error}</div>;
  return (
    <TranscriptView
      tx={tx}
      roster={roster}
      leadLabel="Main session"
      status={live ? "live" : "done"}
      label={info.title}
      empty={j ? "No steps in this session yet." : "Reading the session…"}
    />
  );
}
