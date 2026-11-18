// Server-only: what the Desk page shows, built from the ledger.
import { marketStatus } from "../clock";
import { dailyPnl, deskStats, equityOf, openRisk, r2, type DeskRules, type DeskState } from "../desk";
import { deskAgentEnabled, deskModel } from "../deskAgent";

export function deskView(s: DeskState, rules: DeskRules, rulesFromFile: boolean, nowMs = Date.now()) {
  const ms = marketStatus(nowMs);
  return {
    asOf: new Date(nowMs).toISOString(),
    paper: true,
    market: { open: ms.open, reason: ms.reason, date: ms.date },
    agent: { enabled: deskAgentEnabled(), model: deskModel() },
    driver: s.driver ?? "auto",
    rules,
    rulesFromFile,
    startedAt: s.startedAt,
    startCash: s.startCash,
    cash: s.cash,
    equity: equityOf(s),
    lastRunAt: s.lastRunAt,
    lastAgentAt: s.lastAgentAt,
    lastSummary: s.lastSummary,
    positions: s.positions.map((p) => ({
      ...p,
      unrealized: r2((p.lastPrice - p.entry) * p.qty - p.fees),
      unrealizedPct: p.entry > 0 ? p.lastPrice / p.entry - 1 : 0,
      risk: r2(openRisk(p)),
    })),
    trades: s.trades.slice(-300).reverse(),
    journal: s.journal.slice(0, 150),
    sessions: (s.sessions ?? []).slice(0, 12),
    days: dailyPnl(s),
    stats: deskStats(s, nowMs),
  };
}

export type DeskView = ReturnType<typeof deskView> & { realOrders?: { on: boolean; live: boolean; gateway?: "down" | "login" | "ready" } };
