// Shape of GET /api/status: one row per connector Dodona and its Claude Code skills depend on,
// plus each skill's readiness derived from its dependencies. Pure and shared.

export type CheckState = "ok" | "warn" | "fail" | "off";

export interface StatusCheck {
  key: string;
  group: "Broker" | "Market data" | "Research" | "AI" | "Skills" | "Local";
  name: string;
  state: CheckState;
  detail: string;
  usedBy: string; // which pages / features need it
  fix?: string; // what to do when it isn't ok
  ms?: number; // how long the check took
}

export interface StatusResult {
  asOf: string;
  checks: StatusCheck[];
}

const RANK: Record<CheckState, number> = { fail: 0, warn: 1, off: 2, ok: 3 };

/** The worst state among the checks, and a count per state. "off" (not configured) doesn't fail the whole. */
export function overall(checks: StatusCheck[]): { state: CheckState; counts: Record<CheckState, number> } {
  const counts: Record<CheckState, number> = { ok: 0, warn: 0, fail: 0, off: 0 };
  for (const c of checks) counts[c.state]++;
  const state = counts.fail ? "fail" : counts.warn ? "warn" : "ok";
  return { state, counts };
}

export const byState = (a: StatusCheck, b: StatusCheck) => RANK[a.state] - RANK[b.state];

/** Runs a check with a timeout and timing; a thrown error becomes a "fail" row. */
export async function timed(base: Omit<StatusCheck, "state" | "detail" | "ms">, fn: () => Promise<Pick<StatusCheck, "state" | "detail"> & { fix?: string }>, timeoutMs = 12_000): Promise<StatusCheck> {
  const t0 = Date.now();
  try {
    const r = await Promise.race([
      fn(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs)),
    ]);
    return { ...base, ...r, ms: Date.now() - t0 };
  } catch (e) {
    return { ...base, state: "fail", detail: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
  }
}

// ---------------------------------------------------------------- skills

/** What each Claude Code skill needs. Optional deps only limit the skill (an extra source or feature). */
export const SKILL_DEPS: Array<{ skill: string; does: string; needs: string[]; optional?: string[] }> = [
  { skill: "ibkr-gateway", does: "Reconnect IBKR and sync positions", needs: ["ibkr-gateway"] },
  { skill: "dodona-sync", does: "Sync positions via Claude's IBKR connector", needs: ["ibkr-connector"] },
  { skill: "trader-scanner", does: "Scan the market for setups", needs: ["python", "yahoo-chart", "nasdaq"] },
  { skill: "trader-news", does: "Headlines and 8-Ks for your watchlist", needs: ["python", "yahoo-rss", "yahoo-chart"], optional: ["sec"] },
  { skill: "trader-entry", does: "Time the entry bar by bar", needs: ["python", "yahoo-chart"] },
  { skill: "trader-exit", does: "Set the stop and target", needs: ["python", "yahoo-chart"] },
  { skill: "trader-timemachine", does: "Replay the trade 10,000 times", needs: ["python", "yahoo-chart"] },
  { skill: "trader-budget", does: "Size the position to your budget", needs: ["python", "trader-config"] },
  { skill: "trader-risk", does: "Check the order against your limits", needs: ["python", "trader-config", "portfolio-file"] },
  { skill: "trader-alerts", does: "Price, stop and opening-bell alerts", needs: ["python", "yahoo-chart"], optional: ["yahoo-backup"] },
  { skill: "trader-broker", does: "Send approved orders (paper by default)", needs: ["python", "broker-mcp"] },
  { skill: "trader-analyst", does: "Earnings from SEC filings", needs: ["python", "sec"] },
  { skill: "trader-pelosi", does: "Congress members' disclosed trades", needs: ["python", "house"], optional: ["pdftotext"] },
];

export interface SkillHealth {
  skill: string;
  does: string;
  state: CheckState; // ok = ready, warn = works but limited, fail = broken, off = not set up
  summary: string;
  deps: Array<{ key: string; name: string; state: CheckState; optional: boolean }>;
}

/** A skill is as healthy as its worst required dependency; an optional one can only limit it. */
export function skillHealth(checks: StatusCheck[]): SkillHealth[] {
  const byKey = new Map(checks.map((c) => [c.key, c]));
  return SKILL_DEPS.map(({ skill, does, needs, optional = [] }) => {
    const deps = [...needs.map((k) => ({ k, optional: false })), ...optional.map((k) => ({ k, optional: true }))].map(({ k, optional }) => {
      const c = byKey.get(k);
      return { key: k, name: c?.name ?? k, state: c?.state ?? ("fail" as CheckState), optional };
    });
    const req = deps.filter((d) => !d.optional);
    const opt = deps.filter((d) => d.optional && d.state !== "ok");
    const worst = req.reduce<CheckState>((w, d) => (RANK[d.state] < RANK[w] ? d.state : w), "ok");
    let state: CheckState = worst;
    let summary: string;
    if (worst === "ok") {
      state = opt.length ? "warn" : "ok";
      summary = opt.length ? `Works; limited: ${opt.map((d) => d.name).join(", ")}` : "Ready";
    } else {
      const bad = req.filter((d) => d.state === worst).map((d) => d.name).join(", ");
      summary = worst === "off" ? `Not set up: ${bad}` : worst === "fail" ? `Broken: ${bad}` : `Check: ${bad}`;
    }
    return { skill, does, state, summary, deps };
  });
}
