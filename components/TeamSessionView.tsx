"use client";
// The Claude Code trade team's session (/trade-desk): the lead, each specialist subagent, the
// skills they ran, what came back, and the verdicts they logged. Live while the session runs.
import { useEffect, useMemo, useState } from "react";
import { Spinner } from "@/components/ui";
import type { AgentSession } from "@/lib/desk";
import type { TeamStep, TeamTranscript } from "@/lib/data/transcripts";

export const TEAM_MODEL = "Claude Code trade team";

const ROLE: Record<string, { label: string; icon: string; skill?: string }> = {
  lead: { label: "Lead trader", icon: "✦" },
  "trade-scanner": { label: "Scanner", icon: "⌕", skill: "trader-scanner" },
  "trade-news": { label: "News", icon: "✉", skill: "trader-news" },
  "trade-entry": { label: "Entry", icon: "↗", skill: "trader-entry" },
  "trade-exit": { label: "Exit plan", icon: "⇥", skill: "trader-exit" },
  "trade-timemachine": { label: "Time Machine", icon: "⧖", skill: "trader-timemachine" },
  "trade-analyst": { label: "Analyst", icon: "▤", skill: "trader-analyst" },
  "trade-budget": { label: "Budget", icon: "$", skill: "trader-budget" },
  "trade-risk": { label: "Risk", icon: "⛨", skill: "trader-risk" },
};
const roleOf = (a: string) => ROLE[a] ?? ROLE[`trade-${a}`] ?? { label: a, icon: "•" };
const keyOf = (a: string) => (ROLE[a] ? a : ROLE[`trade-${a}`] ? `trade-${a}` : a);
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

interface Row extends TeamStep {
  logged?: boolean; // a verdict the team wrote to the ledger with `npm run desk -- log`
}

export function TeamSessionView({ session, onLive }: { session: AgentSession; onLive?: () => void }) {
  const [tx, setTx] = useState<TeamTranscript>();
  const [sess, setSess] = useState(session);
  const [only, setOnly] = useState<string>();
  const [raw, setRaw] = useState(false);
  const running = sess.status === "running";

  useEffect(() => setSess(session), [session]);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/desk/team?session=${encodeURIComponent(session.id)}`, { cache: "no-store" });
        const j = await r.json();
        if (!live) return;
        if (j.transcript) setTx(j.transcript);
        if (j.session) {
          setSess(j.session);
          if (j.session.status !== "running" && session.status === "running") onLive?.();
        }
      } catch {
        /* keep the last view */
      }
    };
    load();
    if (session.status !== "running") return () => void (live = false);
    const id = setInterval(load, 3_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [session.id, session.status, onLive]);

  const rows: Row[] = useMemo(() => {
    const logged: Row[] = sess.steps.map((s) => ({ at: s.at, agent: keyOf(s.agent ?? "lead"), kind: s.kind === "decision" ? "report" : "text", title: s.title, detail: s.detail, logged: true }));
    const all = [...logged, ...(raw ? tx?.steps ?? [] : (tx?.steps ?? []).filter((s) => s.kind !== "output" || s.ok === false))].map((r) => ({ ...r, agent: keyOf(r.agent) }));
    return all.filter((r) => !only || r.agent === only).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }, [sess.steps, tx, only, raw]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of [...sess.steps.map((s) => keyOf(s.agent ?? "lead")), ...(tx?.steps ?? []).map((s) => keyOf(s.agent))]) m.set(r, (m.get(r) ?? 0) + 1);
    return m;
  }, [sess.steps, tx]);

  return (
    <div className="as">
      <div className="as-head">
        <span className={`pill ${running ? "act" : sess.status === "done" ? "ok" : "bad"}`}>{running ? <><Spinner /> Live</> : sess.status === "done" ? "Done" : "Stopped"}</span>
        <span className="small">{sess.trigger}</span>
        <span className="spacer" />
        <label className="small muted" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={raw} onChange={() => setRaw(!raw)} /> Every command output
        </label>
      </div>
      <div className="tm-roster">
        {Object.entries(ROLE).map(([k, r]) => (
          <button key={k} className={`tm-member ${only === k ? "on" : ""} ${counts.get(k) ? "active" : ""}`} onClick={() => setOnly(only === k ? undefined : k)} title={r.skill ? `/${r.skill}` : "runs /trade-desk"}>
            <span className="tm-icon">{r.icon}</span>
            <span>{r.label}</span>
            <span className="muted mono">{counts.get(k) ?? 0}</span>
          </button>
        ))}
      </div>
      {sess.summary && <div className="dk-read"><span className="dk-read-icon">✦</span><div>{sess.summary}</div></div>}
      {tx?.note && <div className="small muted">{tx.note}</div>}
      {rows.length === 0 ? (
        <div className="dk-empty">{running ? "The team is starting…" : "No steps recorded for this session."}</div>
      ) : (
        <ol className="as-steps">
          {rows.map((r, i) => {
            const role = roleOf(r.agent);
            return (
              <li key={`${r.at}-${i}`} className={`as-step tm-${r.kind} ${r.ok === false ? "fail" : ""} ${r.logged ? "logged" : ""}`}>
                <span className="as-icon" title={role.label}>{role.icon}</span>
                <details open={r.logged || r.kind === "report" ? i < 6 : false}>
                  <summary>
                    <span className="tm-who">{role.label}</span> <b>{r.title}</b>
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
