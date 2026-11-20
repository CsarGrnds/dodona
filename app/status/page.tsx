"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Brand, Spinner } from "@/components/ui";
import { fmt } from "@/lib/client";
import { byState, overall, skillHealth, type CheckState, type StatusCheck, type StatusResult } from "@/lib/status";

const LABEL: Record<CheckState, string> = { ok: "Working", warn: "Attention", fail: "Down", off: "Not set up" };
const SKILL_LABEL: Record<CheckState, string> = { ok: "Ready", warn: "Limited", fail: "Broken", off: "Not set up" };
const GROUPS: Array<{ key: StatusCheck["group"]; icon: string; blurb: string }> = [
  { key: "Broker", icon: "⇄", blurb: "Interactive Brokers, read-only" },
  { key: "Market data", icon: "◔", blurb: "Prices, bars, fundamentals, news" },
  { key: "Research", icon: "▤", blurb: "Filings and disclosures" },
  { key: "AI", icon: "✦", blurb: "The Claude agent" },
  { key: "Skills", icon: "⌘", blurb: "What the Claude Code skills reach" },
  { key: "Local", icon: "▣", blurb: "Files and calendars on this machine" },
];
const AUTO_KEY = "dodona.status.auto.v1";

export default function StatusPage() {
  const [d, setD] = useState<StatusResult>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [took, setTook] = useState<number>();
  const [auto, setAuto] = useState(false);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(undefined);
    const t0 = Date.now();
    try {
      const r = await fetch("/api/status", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setD(j);
      setTook(Date.now() - t0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
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
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 15_000); // keeps "checked … ago" fresh
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [auto, load]);
  const toggleAuto = () => {
    setAuto((a) => {
      try {
        localStorage.setItem(AUTO_KEY, a ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !a;
    });
  };

  const o = d ? overall(d.checks) : undefined;
  const skills = useMemo(() => (d ? skillHealth(d.checks) : []), [d]);
  const issues = useMemo(() => (d ? d.checks.filter((c) => c.state !== "ok").sort(byState) : []), [d]);
  const skillsReady = skills.filter((s) => s.state === "ok").length;
  const okShare = d && o ? o.counts.ok / d.checks.length : 0;

  return (
    <main className="shell">
      <div className="topbar">
        <Brand sub="status · connectors & skills" />
        <div className="row">
          <Link className="btn ghost" href="/">Watchlist</Link>
          <Link className="btn ghost" href="/today">Today</Link>
          <Link className="btn ghost" href="/portfolio">Portfolio</Link>
          <Link className="btn ghost" href="/desk">Desk</Link>
          <Link className="btn ghost" href="/agents">Agents</Link>
          <Link className="btn ghost" href="/settings">Settings</Link>
        </div>
      </div>

      {err && <div className="panel err" style={{ marginBottom: 14 }}>{err}</div>}
      {!d && !err && (
        <section className="panel sx-hero">
          <div className="sx-ring loading"><Spinner /></div>
          <div>
            <div className="sx-title">Checking every connector…</div>
            <div className="muted small">IBKR, Yahoo, Google, SEC, the House Clerk, Nasdaq, Anthropic and the skills&apos; tools</div>
          </div>
        </section>
      )}

      {d && o && (
        <div className="grid" style={{ gap: 16 }}>
          {/* ---- overview */}
          <section className={`panel sx-hero st-${o.state}`}>
            <div className="sx-ring" style={{ ["--p" as string]: `${okShare * 360}deg` }}>
              <div>
                <b>{o.counts.ok}</b>
                <span>of {d.checks.length}</span>
              </div>
            </div>
            <div className="sx-hero-main">
              <div className="sx-title">
                {o.state === "ok" ? "Everything is connected" : o.state === "warn" ? "Connected, with a few things to look at" : "Something is down"}
              </div>
              <div className="sx-counts">
                <span className="sx-chip st-ok"><i />{o.counts.ok} working</span>
                {o.counts.warn > 0 && <span className="sx-chip st-warn"><i />{o.counts.warn} attention</span>}
                {o.counts.fail > 0 && <span className="sx-chip st-fail"><i />{o.counts.fail} down</span>}
                {o.counts.off > 0 && <span className="sx-chip st-off"><i />{o.counts.off} not set up</span>}
                <span className="sx-chip"><i className="skill" />{skillsReady}/{skills.length} skills ready</span>
              </div>
              <div className="muted small">
                Checked {fmt.ago(d.asOf)}{took ? ` · took ${(took / 1000).toFixed(1)} s` : ""} · live, no cache, read-only
              </div>
            </div>
            <div className="sx-actions">
              <button className="btn primary" onClick={load} disabled={busy}>{busy ? <Spinner /> : "↻"} Check again</button>
              <label className="small muted sx-auto">
                <input type="checkbox" checked={auto} onChange={toggleAuto} /> every minute
              </label>
            </div>
          </section>

          {/* ---- what to fix */}
          {issues.length > 0 && (
            <section className="panel">
              <h2>Needs attention · {issues.length}</h2>
              <div className="sx-issues">
                {issues.map((c) => (
                  <div key={c.key} className={`sx-issue st-${c.state}`}>
                    <i />
                    <div>
                      <div><b>{c.name}</b> <span className="muted small">· {LABEL[c.state]}</span></div>
                      <div className="small">{c.detail}</div>
                      {c.fix && <div className="sx-fix small">{c.fix}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ---- skills */}
          <section className="panel">
            <div className="row" style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>Claude Code skills</h2>
              <span className="spacer" />
              <span className="muted small">a skill is as ready as what it needs</span>
            </div>
            <div className="sx-skills">
              {skills.map((s) => (
                <div key={s.skill} className={`sx-skill st-${s.state}`}>
                  <div className="sx-skill-head">
                    <span className="mono">/{s.skill}</span>
                    <span className={`sx-tag st-${s.state}`}>{SKILL_LABEL[s.state]}</span>
                  </div>
                  <div className="small muted">{s.does}</div>
                  {s.state !== "ok" && <div className="small sx-skill-why">{s.summary}</div>}
                  <div className="sx-deps">
                    {s.deps.map((dep) => (
                      <span key={dep.key} className={`sx-dep st-${dep.state}`} title={`${dep.name}: ${LABEL[dep.state]}${dep.optional ? " (optional)" : ""}`}>
                        <i />{dep.name.replace(/ \(.*\)$/, "")}{dep.optional ? "*" : ""}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <p className="muted small" style={{ margin: "10px 0 0" }}>* optional: the skill works without it, with less.</p>
          </section>

          {/* ---- connectors */}
          {GROUPS.map((g) => {
            const rows = d.checks.filter((c) => c.group === g.key);
            if (!rows.length) return null;
            const go = overall(rows);
            return (
              <section key={g.key} className="panel">
                <div className="sx-group-head">
                  <span className={`sx-group-icon st-${go.state}`}>{g.icon}</span>
                  <div>
                    <h2 style={{ margin: 0 }}>{g.key}</h2>
                    <div className="muted small">{g.blurb}</div>
                  </div>
                  <span className="spacer" />
                  <span className="muted small mono">{go.counts.ok}/{rows.length}</span>
                </div>
                <div className="sx-cards">
                  {rows.map((c) => (
                    <div key={c.key} className={`sx-card st-${c.state}`}>
                      <div className="sx-card-head">
                        <b>{c.name}</b>
                        <span className={`sx-tag st-${c.state}`}>{LABEL[c.state]}</span>
                      </div>
                      <div className="small">{c.detail}</div>
                      {c.fix && c.state !== "ok" && <div className="sx-fix small">{c.fix}</div>}
                      <div className="sx-card-foot small muted">
                        <span>{c.usedBy}</span>
                        {c.ms !== undefined && (
                          <span className="sx-ms mono" title="How long the check took">
                            <span className="sx-ms-bar"><i style={{ width: `${Math.min(100, (c.ms / 3000) * 100)}%` }} /></span>
                            {c.ms < 1000 ? `${c.ms} ms` : `${(c.ms / 1000).toFixed(1)} s`}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}

          <p className="muted small">
            Every check only reads: no orders, no file writes, and no account data leaves this machine. API keys are never read out (the Alpaca check looks only at server names and the paper flag). “Not set up” is optional: Dodona and the skills work without it, with less.
          </p>
        </div>
      )}
    </main>
  );
}
