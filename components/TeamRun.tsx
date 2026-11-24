"use client";
// The trade team's background run, started by the Desk's "Run desk now" button when the team drives
// the desk: /trade-desk live (prepares the IBKR batch; places nothing) or /trade-desk (a paper cycle).
// Shows whether it's running, its latest steps and its answer, and lets you stop it.
import { useCallback, useEffect, useState } from "react";
import { SessionCard } from "@/components/SessionCard";
import { Spinner } from "@/components/ui";
import { nextAutoRun } from "@/lib/autoBatch";
import type { LiveRun } from "@/lib/data/liveRun";

export async function startTeamRun(mode: "live" | "paper"): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch("/api/desk/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start", mode }) });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const time = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  const local = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const ny = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/New_York" });
  return `${local} your time · ${ny} New York`;
};

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
        {r.running ? <><Spinner /> <b>Team working</b></> : <b>{r.error ? "Team run didn't finish" : "Team run done"}</b>}
        <span className="muted">· {r.mode === "paper" ? "paper cycle" : r.mode === "review" ? "daily review" : r.mode === "screen" ? "pre-market shortlist" : "IBKR batch"} · started {time(r.startedAt)}{r.costUsd !== undefined ? ` · ≈ $${r.costUsd.toFixed(2)} at API prices` : ""}</span>
        {r.running && (
          <button className="btn small ghost" onClick={async () => { await fetch("/api/desk/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "stop" }) }); load(); }}>Stop</button>
        )}
      </div>
      {r.running && r.lines.length > 0 && <div className="muted tr-last">{r.lines[r.lines.length - 1]}</div>}
      {!r.running && (r.result || r.error) && <div className={`tr-result ${r.error ? "err" : "muted"}`}>{r.error ? plainResult(r.error) : headline(r.result ?? "")}</div>}
      {!r.running && <SessionCard tick={tick} />}
    </div>
  );
}

/** The run's answer in plain words: Claude's plan limit gets a clear sentence, markdown is dropped. */
function plainResult(text: string): string {
  const limit = text.match(/(?:session|usage|rate) limit[^.]*?(?:resets? ([^.\n)]+))?/i);
  if (limit) return `Your Claude plan's usage limit was reached${limit[1] ? ` (it resets ${limit[1].trim()})` : ""}, so the team couldn't run. Nothing was scanned or placed. Runs work again after the reset.`;
  return text.replace(/\*\*|`/g, "").slice(0, 400);
}

/** The run's answer as one line: its first sentence, before any table or list. The facts come from the session card. */
function headline(text: string): string {
  const plain = plainResult(text);
  if (plain !== text.replace(/\*\*|`/g, "").slice(0, 400)) return plain; // the usage-limit sentence
  const prose = plain.split(/\n|\s\|/)[0].trim();
  return (prose.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? prose).slice(0, 220);
}

/** "Next team run 12:00 New York · in 26:14", ticking every second. */
export function NextRunCountdown({ times, watch = 0 }: { times: string[]; watch?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const next = nextAutoRun(now, times);
  if (!next) return null;
  const s = Math.max(0, Math.round((next.at - now) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const left = h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}:${String(sec).padStart(2, "0")}`;
  const local = new Date(next.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return (
    <div
      className="tr-next small"
      title={watch ? `Every ${watch} minutes from 9:46 AM to 3:00 PM New York, Dodona checks the shortlist itself (no Claude) and starts the team only when a range is ready. Change it in Settings → Broker.` : `Batch times (New York): ${times.join(", ")}. Change them in Settings → Broker.`}
    >
      <span className="muted">{watch ? `Looking every ${watch} min · next look` : "Next team run"}</span> <b>{next.dayLabel === "today" ? "" : `${next.dayLabel} `}{next.time} New York</b>
      <span className="muted"> ({local} your time)</span> · <b className="mono tr-count">{s < 60 ? "starting…" : `in ${left}`}</b>
    </div>
  );
}
