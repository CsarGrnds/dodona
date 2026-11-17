"use client";
// Settings: every trading decision in one place. The rules every /trader-* skill and Dodona's desk
// follow (trader/config.json), who makes the desk's entries, and which model each trade team agent
// runs on. Safety switches (paper, margin, shorts, options) are shown but only changeable in the file.
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Brand, Spinner } from "@/components/ui";
import { AGENT_MODELS, RULE_SECTIONS, TEAM, rulesSummary, validateRules, type Field } from "@/lib/settings";

interface Settings {
  rules: Record<string, unknown>;
  locked: Array<{ key: string; label: string; help: string; safe: unknown; value: unknown }>;
  fromFile: boolean;
  file: string;
  models: Record<string, string>;
  driver: "team" | "auto";
  deskAgent: { enabled: boolean; model: string };
}

const MODEL_INFO: Record<string, string> = {
  haiku: "Haiku · cheapest, runs a script and reports",
  sonnet: "Sonnet · judgment on text",
  opus: "Opus · deepest reasoning, costs most",
  inherit: "Session model · whatever Claude Code runs",
};

/** The form's text for a value, and back. */
const show = (f: Field, v: unknown) => (f.type === "tickers" ? (Array.isArray(v) ? v.join(", ") : "") : f.type === "bool" ? Boolean(v) : v === undefined || v === null ? "" : String(v));
const unit = (f: Field) => (f.type === "usd" ? "$" : f.type === "pct" ? "%" : f.type === "ratio" ? "R" : "");

export default function SettingsPage() {
  const [s, setS] = useState<Settings>();
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [models, setModels] = useState<Record<string, string>>({});
  const [driver, setDriver] = useState<"team" | "auto">("auto");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [err, setErr] = useState<string>();

  const adopt = useCallback((x: Settings) => {
    setS(x);
    const f: Record<string, unknown> = {};
    for (const sec of RULE_SECTIONS) for (const fl of sec.fields) f[fl.key] = show(fl, x.rules[fl.key]);
    setForm(f);
    setModels({ ...x.models });
    setDriver(x.driver);
    setErrors({});
  }, []);

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        adopt(j);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [adopt]);

  // what changed against the saved settings
  const changedRules = useMemo(() => {
    if (!s) return {};
    const out: Record<string, unknown> = {};
    for (const sec of RULE_SECTIONS) for (const f of sec.fields) if (JSON.stringify(show(f, s.rules[f.key])) !== JSON.stringify(form[f.key])) out[f.key] = form[f.key];
    return out;
  }, [s, form]);
  const changedModels = useMemo(() => (s ? Object.fromEntries(Object.entries(models).filter(([k, v]) => s.models[k] !== v)) : {}), [s, models]);
  const dirty = Object.keys(changedRules).length + Object.keys(changedModels).length + (s && driver !== s.driver ? 1 : 0);

  // check as you type, against the whole set so cross-field rules show too
  const preview = useMemo(() => validateRules(form), [form]);
  const live = preview.ok ? {} : preview.errors;
  const shownErrors = { ...live, ...errors };
  const summary = useMemo(() => (preview.ok ? rulesSummary(preview.values) : []), [preview]);

  const set = (k: string, v: unknown) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => {
      const { [k]: _, ...rest } = e;
      return rest;
    });
    setMsg(undefined);
  };

  const save = async () => {
    if (!s || !dirty) return;
    setBusy(true);
    setMsg(undefined);
    setErr(undefined);
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rules: Object.keys(changedRules).length ? form : undefined,
          models: Object.keys(changedModels).length ? changedModels : undefined,
          driver: driver !== s.driver ? driver : undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setErrors(j.errors ?? {});
        setErr(j.errors?._ ?? "Some settings need fixing, marked below.");
        return;
      }
      adopt(j.settings);
      setMsg(`Saved. ${j.saved.includes("rules") ? "The desk, the trade team's paper workspace and every /trader-* skill use the new rules from their next run." : ""}${j.saved.some((x: string) => x.startsWith("model:")) ? " New models apply to the team's next /trade-desk run." : ""}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell">
      <div className="topbar">
        <Brand sub="settings · trading rules" />
        <div className="row">
          <Link className="btn ghost" href="/">Watchlist</Link>
          <Link className="btn ghost" href="/today">Today</Link>
          <Link className="btn ghost" href="/portfolio">Portfolio</Link>
          <Link className="btn ghost" href="/desk">Desk</Link>
          <Link className="btn ghost" href="/status">Status</Link>
        </div>
      </div>

      {!s && !err && <div className="muted"><Spinner /> Reading your settings…</div>}
      {!s && err && <div className="panel err">{err}</div>}

      {s && (
        <div className="grid" style={{ gap: 16 }}>
          {/* ---- save bar */}
          <section className="panel st-bar">
            <div>
              <div className="st-title">Your trading rules</div>
              <div className="small muted">
                Saved in <code>{s.file}</code>{s.fromFile ? "" : " (not created yet: these are the example rules)"}. Dodona&apos;s desk, the trade team and every <code>/trader-*</code> skill follow them; trader-risk blocks anything outside them.
              </div>
              {summary.length > 0 && (
                <ul className="st-summary small">
                  {summary.map((x) => <li key={x}>{x}</li>)}
                </ul>
              )}
            </div>
            <div className="st-actions">
              {msg && <span className="small" style={{ color: "var(--buy)" }}>{msg}</span>}
              {err && <span className="err">{err}</span>}
              <button className="btn ghost" disabled={!dirty || busy} onClick={() => adopt(s)}>Undo changes</button>
              <button className="btn primary" disabled={!dirty || busy || !preview.ok} onClick={save}>
                {busy ? <Spinner /> : dirty ? `Save ${dirty} change${dirty > 1 ? "s" : ""}` : "Saved"}
              </button>
            </div>
          </section>

          {/* ---- rules */}
          <div className="st-grid">
            {RULE_SECTIONS.map((sec) => (
              <section key={sec.id} className="panel">
                <h2>{sec.title}</h2>
                <div className="small muted" style={{ marginBottom: 12 }}>{sec.blurb}</div>
                {sec.fields.map((f) => {
                  const e = shownErrors[f.key];
                  const changed = f.key in changedRules;
                  return (
                    <label key={f.key} className={`st-field ${e ? "bad" : ""} ${changed ? "changed" : ""}`}>
                      <span className="st-label">
                        {f.label}
                        {changed && <span className="st-dot" title="Not saved yet" />}
                      </span>
                      {f.type === "choice" ? (
                        <select className="st-select" value={String(form[f.key] ?? "")} onChange={(ev) => set(f.key, ev.target.value)}>
                          {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      ) : f.type === "bool" ? (
                        <span className="st-switch">
                          <input type="checkbox" checked={Boolean(form[f.key])} onChange={(ev) => set(f.key, ev.target.checked)} />
                          <span className="small">{form[f.key] ? "On" : "Off"}</span>
                        </span>
                      ) : (
                        <span className="st-input">
                          {unit(f) === "$" && <span className="muted">$</span>}
                          <input
                            value={String(form[f.key] ?? "")}
                            onChange={(ev) => set(f.key, ev.target.value)}
                            inputMode={f.type === "usd" || f.type === "pct" || f.type === "ratio" || f.type === "int" ? "decimal" : undefined}
                            placeholder={f.type === "time" ? "09:45" : f.type === "tickers" ? "e.g. GME, AMC" : undefined}
                            className={f.type === "tickers" || f.type === "text" ? "wide" : ""}
                          />
                          {unit(f) && unit(f) !== "$" && <span className="muted">{unit(f)}</span>}
                          {f.type === "time" && <span className="muted small">NY</span>}
                        </span>
                      )}
                      <span className="st-help small muted">{e ? <span className="err">{e}</span> : f.help}</span>
                    </label>
                  );
                })}
              </section>
            ))}
          </div>

          {/* ---- who trades */}
          <div className="st-grid">
            <section className="panel">
              <h2>Who makes the desk&apos;s entries</h2>
              <div className="st-choice">
                {(["team", "auto"] as const).map((k) => (
                  <label key={k} className={`st-option ${driver === k ? "on" : ""}`}>
                    <input type="radio" name="driver" checked={driver === k} onChange={() => { setDriver(k); setMsg(undefined); }} />
                    <span>
                      <b>{k === "team" ? "✦ Claude Code trade team" : s.deskAgent.enabled ? "✦ Dodona's own desk (Claude)" : "Dodona's own desk (rules engine)"}</b>
                      <span className="small muted">
                        {k === "team"
                          ? " /trade-desk finds and books trades with the real skills; Dodona only runs stops, targets and the flat-by time."
                          : s.deskAgent.enabled
                            ? ` Dodona's Run button and auto-run let Claude (${s.deskAgent.model}) pick trades with its research tools.`
                            : " Dodona's Run button takes a setup only when it made money on that stock before. Add ANTHROPIC_API_KEY to let Claude decide."}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="small muted" style={{ marginTop: 10 }}>
                Either way it&apos;s the paper desk: nothing is sent to a broker. Dodona&apos;s own Claude model is set with <code>DODONA_DESK_MODEL</code> in <code>.env.local</code>.
              </div>
            </section>

            <section className="panel">
              <h2>Safety switches</h2>
              <div className="small muted" style={{ marginBottom: 10 }}>
                Shown, not changeable here. They&apos;re yours to change, yourself, in <code>{s.file}</code>.
              </div>
              {s.locked.map((l) => {
                const safe = l.value === l.safe;
                return (
                  <div key={l.key} className="row st-locked">
                    <span className={`pill ${safe ? "ok" : "bad"}`}>{l.key === "paper" ? (l.value ? "Paper" : "LIVE") : l.value ? "Allowed" : "Off"}</span>
                    <span><b className="small">{l.label}</b> <span className="small muted">{l.help}</span></span>
                  </div>
                );
              })}
            </section>
          </div>

          {/* ---- team models */}
          <section className="panel">
            <h2>Trade team models</h2>
            <div className="small muted" style={{ marginBottom: 12 }}>
              Each specialist runs on the cheapest model that does its job well. The lead trader runs on your Claude Code session&apos;s model and makes every call; the booking check is code, not a model. Saved in <code>.claude/agents/trade-*.md</code>.
            </div>
            <div className="st-team">
              {TEAM.map((t) => {
                const m = models[t.agent] ?? "inherit";
                const changed = s.models[t.agent] !== m;
                return (
                  <div key={t.agent} className={`st-agent ${changed ? "changed" : ""}`}>
                    <div>
                      <b>{t.label}</b>
                      {changed && <span className="st-dot" title="Not saved yet" />}
                      <div className="small muted">{t.job}</div>
                    </div>
                    <select value={m} onChange={(e) => { setModels({ ...models, [t.agent]: e.target.value }); setMsg(undefined); }} title={MODEL_INFO[m]}>
                      {AGENT_MODELS.map((x) => (
                        <option key={x} value={x}>{x === "inherit" ? "session" : x}{x === t.suggested ? " ✓" : ""}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
            <div className="small muted" style={{ marginTop: 10 }}>✓ = suggested. {Object.values(MODEL_INFO).join(" · ")}</div>
          </section>
        </div>
      )}
    </main>
  );
}
