"use client";
// The trade team's background run, started by the Desk's "Run desk now" button when the team drives
// the desk: /trade-desk live (prepares the IBKR batch; places nothing) or /trade-desk (a paper cycle).
// Shows whether it's running, its latest steps and its answer, and lets you stop it.
import { useCallback, useEffect, useState } from "react";
import { Spinner } from "@/components/ui";
import type { LiveRun } from "@/lib/data/liveRun";

export async function startTeamRun(mode: "live" | "paper"): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch("/api/desk/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start", mode }) });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "");

export function TeamRunStatus({ tick }: { tick: number }) {
  const [r, setR] = useState<LiveRun>();
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/desk/prepare", { cache: "no-store" });
      if (res.ok) setR(await res.json());
    } catch {
      /* keep the last view */
    }
  }, []);
  useEffect(() => {
    load();
  }, [load, tick]);
  useEffect(() => {
    if (!r?.running) return;
    const id = setInterval(load, 3_000);
    return () => clearInterval(id);
  }, [r?.running, load]);

  if (!r?.startedAt) return <div className="muted small">The team runs in Claude Code; its work shows below.</div>;
  return (
    <div className="tr-status small">
      <div className="row" style={{ gap: 6 }}>
        {r.running ? <><Spinner /> <b>Team working</b></> : <b>{r.error ? "Team run failed" : "Team run done"}</b>}
        <span className="muted">· {r.mode === "paper" ? "paper cycle" : r.mode === "review" ? "daily review" : "IBKR batch"} · {time(r.startedAt)}{r.costUsd !== undefined ? ` · ≈ $${r.costUsd.toFixed(2)} at API prices` : ""}</span>
        {r.running && (
          <button className="btn small ghost" onClick={async () => { await fetch("/api/desk/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "stop" }) }); load(); }}>Stop</button>
        )}
      </div>
      {r.running && r.lines.length > 0 && <div className="muted tr-last">{r.lines[r.lines.length - 1]}</div>}
      {!r.running && (r.result || r.error) && <div className={r.error ? "err" : "muted"}>{(r.error ?? r.result ?? "").replace(/\*\*|`/g, "").slice(0, 400)}</div>}
    </div>
  );
}
