// Server-only: Claude as the desk's trader. It reads the charts and numbers Dodona hands it and
// decides which setups to take and how to manage open paper positions. It never sizes a trade,
// never places an order and cannot loosen a rule: sizing and the risk gate run after it, in code.
import Anthropic from "@anthropic-ai/sdk";
import type { ChartLevels } from "./levels";
import type { MarketContext } from "./market";
import type { TrackRecord } from "./backtest";
import type { AgentSession, DeskRules, DeskState, SessionStep, Style } from "./desk";
import { DESK_TOOLS, runDeskTool, toolLabel } from "./data/deskTools";

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
  daily?: Array<[string, number, number, number, number, number]>; // date, o, h, l, c, volume
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
- You have research tools. Use them the way a professional would before every decision: read the daily chart for trend and structure, the intraday chart for the breakout's quality and where buyers and sellers stepped in, levels and indicators, the setup's track record on that stock, the news and the next earnings date, the market and sector backdrop, and this desk's own history. Look at the chart of every candidate before you buy it. Check the market overview once per session. Don't fetch what you don't need.
- Reason only from the data you are given or fetch. Never invent prices, news or numbers. If something you need is missing, say so and lean toward skipping.
- Capital preservation first. Skipping is a good trade. Take only setups where the chart, the market and the setup's own track record line up. A thin or negative track record needs a strong chart reason to override.
- Every entry needs a stop below a real level (under support, the opening-range midpoint, VWAP, or ~1.5-2 ATR) and a target before overhead resistance. Reward:risk must be at least the account's minimum. You do not choose the size: the desk sizes every trade to the account's rules after you, and a trade whose fees are too large against its risk is refused, so very tight stops on cheap stocks won't fill.
- Day trades are closed by the flat-by time. Swing trades hold days to weeks; treat an earnings date inside the hold as gap risk.
- Managing open positions: hold while the thesis is intact; raise a stop to lock in gains under a new higher low or once price is well in profit (a stop can only go up and must stay below the price); close early only when the chart clearly breaks the thesis. Do not close a trade just because it is red: the stop is the plan.
- Be concise and concrete in "why": name the levels and the evidence you looked at. This is a paper account for testing whether the approach is profitable; nothing you say is financial advice.

When your research is done, answer with JSON in the required schema: one entry decision per candidate key and one position decision per open position id.`;

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

/** The one SDK call the loop makes; a stand-in can be passed in tests. */
export type DeskClient = { beta: { messages: { create: (p: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.BetaMessage> } } };

export const MAX_ROUNDS = 14; // model calls per session
export const MAX_TOOL_CALLS = 40;
const PREVIEW = 700;

export async function runDeskAgent(
  input: {
    now: string; // New York time label
    rules: DeskRules;
    account: { equity: number; cash: number; dailyRoom: number; tradesLeftToday: number };
    market?: MarketContext;
    candidates: CandidateInput[];
    positions: PositionInput[];
    recentTrades: Array<{ symbol: string; setup: string; pnl: number; R: number; reason: string; date: string }>;
  },
  ctx: { nowMs: number; today: string; desk: DeskState },
  session: AgentSession,
  onStep: () => void,
  client: DeskClient = new Anthropic(),
): Promise<DeskDecision> {
  const step = (x: Omit<SessionStep, "at">) => {
    session.steps.push({ at: new Date().toISOString(), ...x });
    onStep();
  };
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
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: `Desk check at ${input.now}. Research what you need with the tools, then decide.\n\n${JSON.stringify(payload)}` },
  ];
  let calls = 0;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    session.rounds = round;
    const msg = await client.beta.messages.create({
      model: deskModel(),
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      tools: DESK_TOOLS,
      system: SYSTEM,
      messages,
    });
    session.usage.input += msg.usage.input_tokens;
    session.usage.output += msg.usage.output_tokens;
    session.usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
    for (const b of msg.content) {
      if (b.type === "thinking" && b.thinking.trim()) step({ kind: "thinking", title: "Thinking", detail: b.thinking.trim() });
      if (b.type === "text" && b.text.trim() && msg.stop_reason === "tool_use") step({ kind: "text", title: "Note", detail: b.text.trim() });
    }
    if (msg.stop_reason === "refusal") throw new Error("Claude declined this desk check");
    if (msg.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off");
    if (msg.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: msg.content });
      continue;
    }
    if (msg.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: msg.content });
      const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = await Promise.all(
        uses.map(async (u) => {
          const args = (u.input ?? {}) as Record<string, unknown>;
          const label = toolLabel(u.name, args);
          if (++calls > MAX_TOOL_CALLS) {
            step({ kind: "tool", title: label, tool: u.name, input: args, ok: false, detail: "Research budget used up." });
            return { type: "tool_result", tool_use_id: u.id, is_error: true, content: `Research budget of ${MAX_TOOL_CALLS} tool calls is used up: decide with what you have.` };
          }
          const t0 = Date.now();
          try {
            const out = JSON.stringify(await runDeskTool(u.name, args, ctx));
            step({ kind: "tool", title: label, tool: u.name, input: args, ok: true, ms: Date.now() - t0, detail: out.length > PREVIEW ? `${out.slice(0, PREVIEW)}…` : out });
            return { type: "tool_result", tool_use_id: u.id, content: out };
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            step({ kind: "tool", title: label, tool: u.name, input: args, ok: false, ms: Date.now() - t0, detail: err });
            return { type: "tool_result", tool_use_id: u.id, is_error: true, content: err };
          }
        }),
      );
      session.toolCalls = Math.min(calls, MAX_TOOL_CALLS);
      if (round === MAX_ROUNDS - 1) {
        messages.push({ role: "user", content: [...results, { type: "text", text: "That was the last research round: give your final JSON decision now." }] });
      } else messages.push({ role: "user", content: results });
      continue;
    }
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const d = parseDeskDecision(JSON.parse(text));
    const buys = d.entries.filter((e) => e.decision === "buy").length;
    step({ kind: "decision", title: `Decided: ${buys} buy${buys === 1 ? "" : "s"}, ${d.entries.length - buys} skip${d.entries.length - buys === 1 ? "" : "s"}, ${d.positions.length} position${d.positions.length === 1 ? "" : "s"} reviewed`, detail: d.summary });
    return d;
  }
  throw new Error(`no decision after ${MAX_ROUNDS} rounds`);
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
