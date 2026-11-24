import assert from "node:assert/strict";
import { test } from "node:test";
import { rulesBrief } from "../lib/budget";

test("rules brief: the numbers in force, worked out from the budget when the switch is on", () => {
  const cfg = { budget: 200, cash_buffer_pct: 20, max_position_pct: 75, auto_from_budget: true, risk_pct: 2, daily_loss_pct: 5, max_loss_per_trade_usd: 50, max_daily_loss_usd: 150, max_trades_per_day: 3, max_fee_pct: 150, no_entries_before: "09:45", no_entries_after: "15:30", paper: false };
  const b = rulesBrief(cfg);
  assert.match(b, /trading money \$200 \(20% kept in cash, so up to \$150 in one trade\)/);
  // the stale $50 / $150 in the file never reach the team while the limits follow the budget
  assert.match(b, /max loss \$4 a trade and \$10 a day \(2% and 5% of the money\)/);
  assert.match(b, /fees at most 150%/);
  assert.match(b, /REAL MONEY/);
  // the money changes on the Desk: the next run sees the new limits
  assert.match(rulesBrief({ ...cfg, budget: 300 }), /max loss \$6 a trade and \$15 a day/);
  // switch off: the dollars in the file
  assert.match(rulesBrief({ ...cfg, auto_from_budget: false, paper: true }), /max loss \$50 a trade and \$150 a day; .*practice/);
});
