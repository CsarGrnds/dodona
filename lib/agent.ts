import Anthropic from "@anthropic-ai/sdk";
import type { Action, AgentView, Fundamentals, Indicators, NewsItem, Quote, RuleSignal, Strategy } from "./types";

export interface PreviousCall {
  action: Action;
  price: number;
  generatedAt: string;
  thesis?: string;
}

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

const SYSTEM = `You are Dodona, an equity research agent that follows ONE company and issues a BUY, SELL or HOLD call.

Rules:
- Reason only from the data provided. Do not invent numbers, events or prices. If data is missing, say so and lower confidence.
- The quantitative rule engine has already scored the stock. Treat its factors as evidence; you may agree or override, but explain any override.
- Strategy "dividend" = long-term dividend-growth investor: favor accumulating quality at good yields, trimming only on clear overvaluation or dividend-safety risk. Avoid churn.
- Strategy "swing" = multi-day to multi-week technical trader: respect trend, momentum and risk levels.
- If a previous call exists, say whether it still holds and what changed. Don't flip calls on noise.
- Be concise and concrete. This is decision support, not financial advice.

Respond with ONLY a JSON object, no prose around it:
{"action":"BUY"|"SELL"|"HOLD","confidence":0..1,"thesis":"2-4 sentences","risks":["..."],"watchFor":["specific triggers that would change the call, with price levels where possible"]}`;

export function agentEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function runAgent(input: {
  strategy: Strategy;
  quote: Quote;
  indicators: Indicators;
  fundamentals: Fundamentals;
  rules: RuleSignal;
  news: NewsItem[];
  previous?: PreviousCall;
}): Promise<AgentView> {
  const client = new Anthropic();
  const payload = {
    strategy: input.strategy,
    asOf: input.quote.asOf,
    quote: input.quote,
    indicators: round(input.indicators),
    fundamentals: input.fundamentals,
    ruleEngine: {
      action: input.rules.action,
      score: input.rules.score,
      confidence: input.rules.confidence,
      factors: input.rules.factors,
      levels: input.rules.levels,
    },
    recentNews: input.news.slice(0, 8).map((n) => ({ title: n.title, publisher: n.publisher, publishedAt: n.publishedAt })),
    previousCall: input.previous ?? null,
  };

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: SYSTEM,
    messages: [{ role: "user", content: `Analyze ${input.quote.symbol}.\n\n${JSON.stringify(payload, null, 2)}` }],
  });

  const text = msg.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  const parsed = extractJson(text);
  const action = String(parsed.action ?? "").toUpperCase();
  if (action !== "BUY" && action !== "SELL" && action !== "HOLD") throw new Error("Agent returned no valid action");
  return {
    action,
    confidence: clamp(Number(parsed.confidence) || 0),
    thesis: String(parsed.thesis ?? ""),
    risks: Array.isArray(parsed.risks) ? parsed.risks.map(String).slice(0, 6) : [],
    watchFor: Array.isArray(parsed.watchFor) ? parsed.watchFor.map(String).slice(0, 6) : [],
    model: MODEL,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Agent response was not JSON");
  return JSON.parse(candidate.slice(start, end + 1));
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));

function round(o: Indicators): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? Number(v.toFixed(4)) : v]),
  );
}
