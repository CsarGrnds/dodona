// Server-only: Claude as the desk's trader. It reads the charts and numbers Dodona hands it and
// decides which setups to take and how to manage open paper positions. It never sizes a trade,
// never places an order and cannot loosen a rule: sizing and the risk gate run after it, in code.
import Anthropic from "@anthropic-ai/sdk";
import type { ChartLevels } from "./levels";
import type { MarketContext } from "./market";
import type { TrackRecord } from "./backtest";
import type { DeskRules, Style } from "./desk";

export const deskModel = () => process.env.DODONA_DESK_MODEL || "claude-opus-5-5";
export const deskAgentEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

export interface CandidateInput {
  key: string;
  symbol: string;
  style: Style;
  setup: string;
  setupRule: string;
  price: number;
  suggested: { stop: number; target: number }; // the rule engine's levels
  record?: TrackRecord; // this setup's past trades on this stock
  daily: Array<[string, number, number, number, number, number]>; // date, o, h, l, c, volume (last 60)
  intraday?: Array<[string, number, number, number, number, number]>; // today's 5-minute bars, NY time
  indicators: Record<string, number | boolean | undefined>;
  levels?: ChartLevels;
  relativeStrength3m?: number;
  nextEarningsDate?: string;
  news?: string[];
}

export interface PositionInput {
  id: string;
  symbol: string;
  style: Style;
  setup: string;
  qty: number;
  entry: number;
  stop: number;
  target: number;
  price: number;
  openedAt: string;
  thesis: string;
  intraday?: CandidateInput["intraday"];
  daily?: CandidateInput["daily"];
}

export interface DeskDecision {
  summary: string;
  positions: Array<{ id: string; action: "hold" | "close" | "raise_stop"; new_stop: number | null; why: string }>;
  entries: Array<{ key: string; decision: "buy" | "skip"; stop: number | null; target: number | null; confidence: number; why: string }>;
}

const SYSTEM = `You are the trader on Dodona's paper trading desk: a disciplined professional day and swing trader for a small long-only stock account.

How you work:
- Read the charts you are given (daily and 5-minute OHLCV bars, indicators, support and resistance, the market) the way a professional would: trend, structure, volume, where the risk is and where price is likely to stall.
- Reason only from the data provided. Never invent prices, news or numbers. If something you would want is missing, say so and lean toward skipping.
- Capital preservation first. Skipping is a good trade. Take only setups where the chart, the market and the setup's own track record line up. A thin or negative track record needs a strong chart reason to override.
- Every entry needs a stop below a real level (under support, the opening-range midpoint, or ~1.5-2 ATR) and a target before overhead resistance. Reward:risk must be at least the account's minimum. You do not choose the size: the desk sizes every trade to the account's rules after you.
- Day trades are closed by the flat-by time. Swing trades hold days to weeks; treat an earnings date inside the hold as gap risk.
- Managing open positions: hold while the thesis is intact; raise a stop to lock in gains under a new higher low or once price is well in profit (a stop can only go up and must stay below the price); close early only when the chart clearly breaks the thesis. Do not close a trade just because it is red: the stop is the plan.
- Be concise and concrete in "why": name the levels and the evidence. This is a paper account for testing whether the approach is profitable; nothing you say is financial advice.

Answer with JSON in the required schema. Give one entry decision per candidate key and one position decision per open position id.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "positions", "entries"],
  properties: {
    summary: { type: "string", description: "2-3 sentences: the market read and what the desk is doing" },
    positions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "action", "new_stop", "why"],
        properties: {
          id: { type: "string" },
          action: { type: "string", enum: ["hold", "close", "raise_stop"] },
          new_stop: { type: ["number", "null"] },
          why: { type: "string" },
        },
      },
    },
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "decision", "stop", "target", "confidence", "why"],
        properties: {
          key: { type: "string" },
          decision: { type: "string", enum: ["buy", "skip"] },
          stop: { type: ["number", "null"] },
          target: { type: ["number", "null"] },
          confidence: { type: "number" },
          why: { type: "string" },
        },
      },
    },
  },
} as const;

export async function runDeskAgent(input: {
  now: string; // New York time label
  rules: DeskRules;
  account: { equity: number; cash: number; dailyRoom: number; tradesLeftToday: number };
  market?: MarketContext;
  candidates: CandidateInput[];
  positions: PositionInput[];
  recentTrades: Array<{ symbol: string; setup: string; pnl: number; R: number; reason: string; date: string }>;
}): Promise<DeskDecision> {
  const client = new Anthropic();
  const payload = {
    now: input.now,
    account: input.account,
    rules: {
      minRewardRisk: input.rules.min_reward_risk,
      maxLossPerTradeUsd: input.rules.max_loss_per_trade_usd,
      noEntriesBefore: input.rules.no_entries_before,
      noEntriesAfter: input.rules.no_entries_after,
      flatBy: input.rules.flat_by,
    },
    market: input.market ?? null,
    openPositions: input.positions,
    candidates: input.candidates,
    recentClosedTrades: input.recentTrades,
  };
  const msg = await client.beta.messages.create({
    model: deskModel(),
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: `Desk check at ${input.now}.\n\n${JSON.stringify(payload)}` }],
  });
  if (msg.stop_reason === "refusal") throw new Error("Claude declined this desk check");
  if (msg.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off");
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return parseDeskDecision(JSON.parse(text));
}

/** Defensive parse: the desk acts only on well-formed decisions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseDeskDecision(o: any): DeskDecision {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    summary: typeof o?.summary === "string" ? o.summary : "",
    positions: (Array.isArray(o?.positions) ? o.positions : [])
      .filter((p: { id?: unknown; action?: unknown }) => typeof p?.id === "string" && ["hold", "close", "raise_stop"].includes(p?.action as string))
      .map((p: { id: string; action: DeskDecision["positions"][number]["action"]; new_stop?: unknown; why?: unknown }) => ({ id: p.id, action: p.action, new_stop: num(p.new_stop), why: String(p.why ?? "") })),
    entries: (Array.isArray(o?.entries) ? o.entries : [])
      .filter((e: { key?: unknown; decision?: unknown }) => typeof e?.key === "string" && (e?.decision === "buy" || e?.decision === "skip"))
      .map((e: { key: string; decision: "buy" | "skip"; stop?: unknown; target?: unknown; confidence?: unknown; why?: unknown }) => ({
        key: e.key,
        decision: e.decision,
        stop: num(e.stop),
        target: num(e.target),
        confidence: Math.max(0, Math.min(1, num(e.confidence) ?? 0)),
        why: String(e.why ?? ""),
      })),
  };
}
