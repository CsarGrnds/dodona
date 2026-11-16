import { agentEnabled, runAgent, type PreviousCall } from "./agent";
import { getMarketBars, getSnapshot } from "./data";
import { marketAt, marketSeries, relativeStrength } from "./market";
import { computeIndicators } from "./indicators";
import { supportResistance } from "./levels";
import { ruleSignal } from "./signals";
import type { Analysis, Strategy } from "./types";

export async function analyze(symbol: string, strategy: Strategy, opts: { previous?: PreviousCall; useAgent?: boolean } = {}): Promise<Analysis> {
  const [snap, spy] = await Promise.all([getSnapshot(symbol), getMarketBars().catch(() => [])]);
  const price = snap.quote.price;
  const indicators = computeIndicators(snap.bars, price);
  const warnings = [...snap.warnings];
  const ms = spy.length ? marketSeries(spy) : undefined;
  const market = ms ? marketAt(ms) : undefined;
  const rs = ms && snap.bars.length ? relativeStrength(snap.bars, snap.bars.length - 1, ms) : undefined;
  if (!market) warnings.push("Market benchmark (SPY) unavailable: market and relative-strength factors skipped.");
  const chartLevels = snap.bars.length > 20 ? supportResistance(snap.bars, price, indicators.atr14) : undefined;
  const rules = ruleSignal(strategy, price, indicators, snap.fundamentals, { market, relativeStrength: rs });

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
        market,
        relativeStrength: rs,
        chartLevels,
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
    market,
    relativeStrength: rs,
    chartLevels,
  };
}
