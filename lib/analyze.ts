import { agentEnabled, runAgent, type PreviousCall } from "./agent";
import { getSnapshot } from "./data";
import { computeIndicators } from "./indicators";
import { ruleSignal } from "./signals";
import type { Analysis, Strategy } from "./types";

export async function analyze(symbol: string, strategy: Strategy, opts: { previous?: PreviousCall; useAgent?: boolean } = {}): Promise<Analysis> {
  const snap = await getSnapshot(symbol);
  const price = snap.quote.price;
  const indicators = computeIndicators(snap.bars, price);
  const rules = ruleSignal(strategy, price, indicators, snap.fundamentals);
  const warnings = [...snap.warnings];

  let agent: Analysis["agent"];
  let agentError: string | undefined;
  if (opts.useAgent !== false && agentEnabled()) {
    try {
      agent = await runAgent({
        strategy,
        quote: snap.quote,
        indicators,
        fundamentals: snap.fundamentals,
        rules,
        news: snap.news,
        previous: opts.previous,
      });
    } catch (e) {
      agentError = e instanceof Error ? e.message : String(e);
    }
  } else if (!agentEnabled()) {
    warnings.push("ANTHROPIC_API_KEY not set — showing rule-engine call only.");
  }

  return {
    symbol: snap.quote.symbol,
    strategy,
    generatedAt: new Date().toISOString(),
    quote: snap.quote,
    indicators,
    fundamentals: snap.fundamentals,
    rules,
    agent,
    agentError,
    final: agent
      ? { action: agent.action, confidence: agent.confidence, source: "agent" }
      : { action: rules.action, confidence: rules.confidence, source: "rules" },
    news: snap.news,
    bars: snap.bars.slice(-260),
    warnings,
  };
}
