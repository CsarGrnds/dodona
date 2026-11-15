"use client";
import { useEffect, useMemo, useState } from "react";
import { fmt } from "@/lib/client";
import { buildTradePlan, DEFAULT_PLAN_SETTINGS, normalizePlanSettings, type PlanSettings } from "@/lib/plan";
import { getPlanSettings, setPlanSettings } from "@/lib/store";
import type { Analysis } from "@/lib/types";

type NumKey = Exclude<keyof PlanSettings, "blocked">;
const FIELDS: Array<{ key: NumKey; label: string; pct?: boolean; step: number }> = [
  { key: "account", label: "Account $", step: 100 },
  { key: "maxLossPerTrade", label: "Max loss / trade $", step: 10 },
  { key: "maxPositionPct", label: "Max position %", pct: true, step: 1 },
  { key: "cashBuffer", label: "Cash buffer $", step: 100 },
  { key: "stopAtr", label: "Stop × ATR", step: 0.25 },
  { key: "targetR", label: "Target × risk (R)", step: 0.25 },
  { key: "minRewardRisk", label: "Min reward:risk", step: 0.25 },
  { key: "minStopPct", label: "Min stop %", pct: true, step: 0.1 },
];

export default function TradePlan({ analysis }: { analysis: Analysis }) {
  const [s, setS] = useState<PlanSettings>(DEFAULT_PLAN_SETTINGS);
  useEffect(() => setS(getPlanSettings()), []);

  const update = (next: PlanSettings) => {
    const clean = normalizePlanSettings(next);
    setS(clean);
    setPlanSettings(clean);
  };

  const plan = useMemo(
    () =>
      buildTradePlan(
        { symbol: analysis.symbol, action: analysis.final.action, price: analysis.quote.price, atr14: analysis.indicators.atr14 },
        s,
      ),
    [analysis, s],
  );

  return (
    <section className="panel">
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Trade plan · long</h2>
        <span className="spacer" />
        {plan.status !== "NONE" && <span className={`plan-status ${plan.status}`}>{plan.status}</span>}
      </div>
      <p className={plan.status === "BLOCKED" ? "down small" : "small"} style={{ marginTop: 0 }}>{plan.reason}</p>

      {plan.status !== "NONE" && (
        <>
          <div className="kv">
            <div><span>Entry ~</span><span>{fmt.money(plan.entry)}</span></div>
            <div><span>Stop</span><span className="down">{fmt.money(plan.stop)}</span></div>
            <div><span>Target</span><span className="up">{fmt.money(plan.target)}</span></div>
            <div><span>Risk / share</span><span>{fmt.money(plan.riskPerShare)}</span></div>
            <div><span>Reward : risk</span><span>{plan.rewardRisk?.toFixed(2)} : 1</span></div>
            <div><span>Shares</span><span>{plan.shares}{plan.sizedBy ? ` (by ${plan.sizedBy})` : ""}</span></div>
            <div><span>Cost</span><span>{fmt.money(plan.cost)}</span></div>
            <div><span>Max loss at stop</span><span className="down">{fmt.money(plan.maxLoss)}</span></div>
            <div><span>Gain at target</span><span className="up">{fmt.money(plan.maxGain)}</span></div>
          </div>
          <table style={{ marginTop: 12 }}>
            <thead><tr><th>Check</th><th></th><th>Evidence</th></tr></thead>
            <tbody>
              {plan.checks.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td className={c.pass ? "score-pos" : "score-neg"}>{c.pass ? "PASS" : "BLOCK"}</td>
                  <td className="muted">{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <details style={{ marginTop: 12 }}>
        <summary className="muted small">Your limits (saved in this browser)</summary>
        <div className="plan-form">
          {FIELDS.map((f) => (
            <label key={f.key}>
              <span>{f.label}</span>
              <input
                type="number"
                min={0}
                step={f.step}
                value={f.pct ? Number((s[f.key] * 100).toFixed(4)) : s[f.key]}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isFinite(v)) return;
                  update({ ...s, [f.key]: f.pct ? v / 100 : v });
                }}
              />
            </label>
          ))}
          <label className="wide">
            <span>Blocked tickers</span>
            <input
              type="text"
              placeholder="e.g. GME, AMC"
              defaultValue={s.blocked.join(", ")}
              key={s.blocked.join(",")}
              onBlur={(e) => update({ ...s, blocked: e.target.value.split(/[,\s]+/) })}
            />
          </label>
        </div>
        <button className="btn" style={{ marginTop: 8 }} onClick={() => update(DEFAULT_PLAN_SETTINGS)}>Reset to defaults</button>
      </details>

      <p className="muted small" style={{ marginBottom: 0 }}>
        Plan only, nothing is placed. The target follows your Target × R setting, so it can differ from the rule engine&apos;s Levels. The max loss assumes the stop fills at its price; a gap can fill worse. Uses daily bars, so the stop is sized for swing moves, not intraday.
      </p>
    </section>
  );
}
