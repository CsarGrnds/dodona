"use client";
// Agents: the trade team in a row, each with its profile, the Claude Code subagent file that governs it
// (.claude/agents/trade-*.md). Pick one to read what it's told to do, its tools and model, and edit the
// file in place. Saves are checked on the server (name, model, tools, the "NEVER AN ORDER" rule). The
// lead's profile is its /trade-desk skill, shown read-only. Opened from the floor's right-click Inspect.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Doll, SEATS } from "@/components/TradingFloor";
import { Brand, Spinner } from "@/components/ui";
import type { AgentProfileView } from "@/lib/agentProfile";

export default function AgentsPage() {
  return (
    <Suspense fallback={<main className="shell"><Spinner /></main>}>
      <Agents />
    </Suspense>
  );
}

function Agents() {
  const router = useRouter();
  const params = useSearchParams();
  const [list, setList] = useState<AgentProfileView[]>();
  const [err, setErr] = useState<string>();
  const sel = params.get("agent") ?? "trade-screener";
  const [draft, setDraft] = useState<string>();
  const [errors, setErrors] = useState<string[]>([]);
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/agents", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      setList(j.profiles);
      setErr(undefined);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const cur = useMemo(() => list?.find((p) => p.agent === sel) ?? list?.[1], [list, sel]);
  const dirty = draft !== undefined && cur !== undefined && draft !== cur.text;

  const pick = (agent: string) => {
    if (dirty && !confirm("Discard your unsaved edits?")) return;
    setDraft(undefined);
    setEditing(false);
    setErrors([]);
    setMsg(undefined);
    router.replace(`/agents?agent=${agent}`, { scroll: false });
  };

  const save = async () => {
    if (!cur || draft === undefined) return;
    setBusy(true);
    setErrors([]);
    setMsg(undefined);
    try {
      const r = await fetch("/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: cur.agent, text: draft, base: cur.hash }) });
      const j = await r.json();
      if (!j.ok) return setErrors(j.errors ?? [r.statusText]);
      setList((l) => l?.map((p) => (p.agent === cur.agent ? j.profile : p)));
      setDraft(undefined);
      setEditing(false);
      setMsg(`Saved ${cur.file}. The team uses it from its next run (the previous version is in trader/agent-undo/).`);
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
    }
  };

  // leaving the page with unsaved edits
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const body = cur ? cur.text.replace(/^---\n[\s\S]*?\n---\n?/, "") : "";

  return (
    <main className="shell">
      <div className="topbar">
        <Brand sub="agents · the trade team's profiles" />
        <div className="row">
          <Link className="btn ghost" href="/">Watchlist</Link>
          <Link className="btn ghost" href="/today">Today</Link>
          <Link className="btn ghost" href="/portfolio">Portfolio</Link>
          <Link className="btn ghost" href="/desk">Desk</Link>
          <Link className="btn ghost" href="/settings">Settings</Link>
        </div>
      </div>

      {!list && !err && <div className="muted"><Spinner /> Reading the team's profiles…</div>}
      {err && <div className="panel err">{err}</div>}

      {list && (
        <>
          <div className="ag-row" role="tablist" aria-label="Trade team">
            {list.map((p) => {
              const s = SEATS[p.agent];
              return (
                <button key={p.agent} role="tab" aria-selected={p.agent === cur?.agent} className={`ag-card ${p.agent === cur?.agent ? "on" : ""}`} style={{ ["--c" as string]: s?.shirt ?? "var(--accent)" }} onClick={() => pick(p.agent)}>
                  <span className="ag-stage" aria-hidden><Doll agent={p.agent} size={64} active={p.agent === cur?.agent} /></span>
                  <b>{p.label}</b>
                  <span className="small muted">{p.job}</span>
                  <span className="ag-meta mono small">{p.agent === "lead" ? "skill" : p.model ?? "?"}</span>
                </button>
              );
            })}
          </div>

          {cur && (
            <section className="panel ag-profile" style={{ ["--c" as string]: SEATS[cur.agent]?.shirt ?? "var(--accent)" }}>
              <div className="ag-head">
                <div className="ag-hero">
                  <div className="ag-spot" aria-hidden><Doll agent={cur.agent} size={110} active /></div>
                  <div>
                  <span className="ag-lvl mono small">{cur.agent === "lead" ? "TEAM LEAD" : `${(cur.model ?? "?").toUpperCase()} CLASS`}</span>
                  <h3>{cur.label}</h3>
                  <div className="small muted">{cur.job}</div>
                  <div className="mono small muted">{cur.file}{cur.modified ? ` · saved ${new Date(cur.modified).toLocaleString()}` : ""}</div>
                  </div>
                </div>
                <div className="row">
                  {cur.editable && !editing && <button className="btn" onClick={() => { setDraft(cur.text); setEditing(true); setMsg(undefined); }}>Edit</button>}
                  {editing && (
                    <>
                      <button className="btn ghost" disabled={busy} onClick={() => { if (!dirty || confirm("Discard your edits?")) { setDraft(undefined); setEditing(false); setErrors([]); } }}>Cancel</button>
                      <button className="btn primary" disabled={!dirty || busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
                    </>
                  )}
                </div>
              </div>

              {cur.agent === "lead" ? (
                <p className="small muted">The lead is the /trade-desk skill that runs each cycle. It holds the team&apos;s order rules, so it&apos;s read-only here: change it in Claude Code.</p>
              ) : (
                <div className="ag-facts">
                  <div><span className="muted small">Model</span><b className="mono">{cur.model}</b> <Link className="small muted" href="/settings">change in Settings</Link></div>
                  <div><span className="muted small">Tools</span>{cur.tools.map((t) => <span key={t} className="pill">{t}</span>)}</div>
                  <div className="ag-desc"><span className="muted small">When the lead calls it</span>{cur.description}</div>
                </div>
              )}

              {msg && <div className="panel ag-ok small">{msg}</div>}
              {errors.length > 0 && (
                <div className="panel err small">
                  Not saved:
                  <ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul>
                </div>
              )}

              {editing ? (
                <>
                  <textarea className="ag-editor mono" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`${cur.file} contents`}
                    onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (dirty) void save(); } }} />
                  <p className="small muted">
                    Keep the name, a model Settings knows, tools from Bash, Read, Glob, Grep{cur.agent === "trade-coach" ? ", Edit, Write" : ""}, and the &quot;NEVER AN ORDER&quot; ground rule word for word. ⌘S saves.
                  </p>
                </>
              ) : (
                <pre className="ag-body">{cur.agent === "lead" ? cur.text : body}</pre>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}
