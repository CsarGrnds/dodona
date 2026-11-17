import assert from "node:assert/strict";
import { test } from "node:test";
import { FIELDS, rulesSummary, validateRules } from "../lib/settings";

const MINE = {
  budget: "200", cash_buffer_pct: "20", max_position_pct: "75", max_order_usd: "4000", min_order_usd: "5",
  max_loss_per_trade_usd: "50", max_daily_loss_usd: "150", min_reward_risk: "1", require_stop: true,
  max_trades_per_day: "3", max_orders_per_day: "10", no_entries_before: "09:45", no_entries_after: "15:30", flat_by: "15:55",
  blocked: "gme, amc", fractional: false, sec_user_agent: "Me me@example.com",
};

test("settings: valid rules come back cleaned", () => {
  const r = validateRules({ ...MINE, budget: "$1,200", no_entries_before: "9:45" });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.values.budget, 1200);
  assert.equal(r.values.no_entries_before, "09:45");
  assert.deepEqual(r.values.blocked, ["GME", "AMC"]);
  assert.equal(r.values.require_stop, true);
  // only known fields: paper, margin and the rest can't be set through here
  assert.equal(validateRules({ paper: false, allow_margin: true }).ok, true);
  const v = validateRules({ paper: false, allow_margin: true });
  assert.deepEqual(v.ok && v.values, {});
  assert.ok(!FIELDS.some((f) => ["paper", "allow_margin", "allow_short", "allow_options"].includes(f.key)));
});

test("settings: bad values are sent back, never replaced", () => {
  const errs = (o: Record<string, unknown>) => {
    const r = validateRules({ ...MINE, ...o });
    return r.ok ? {} : r.errors;
  };
  assert.match(errs({ budget: "lots" }).budget, /number/);
  assert.match(errs({ cash_buffer_pct: "120" }).cash_buffer_pct, /at most 100/);
  assert.match(errs({ max_trades_per_day: "2.5" }).max_trades_per_day, /whole/);
  assert.match(errs({ max_loss_per_trade_usd: "200" }).max_daily_loss_usd, /at least the max loss per trade/);
  assert.match(errs({ min_order_usd: "5000" }).min_order_usd, /biggest order/);
  assert.match(errs({ no_entries_before: "09:00" }).no_entries_before, /09:30/);
  assert.match(errs({ no_entries_after: "09:40" }).no_entries_after, /after/);
  assert.match(errs({ flat_by: "16:30" }).flat_by, /16:00/);
  assert.match(errs({ flat_by: "25:00" }).flat_by, /time/);
  assert.match(errs({ blocked: "GME, $$$" }).blocked, /ticker/);
  assert.match(errs({ require_stop: "yes" }).require_stop, /on or off/);
});

test("settings: the summary says what the rules mean", () => {
  const r = validateRules(MINE);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(rulesSummary(r.values), [
    "$160 of $200 can be traded; $40 stays in cash.",
    "A trade risks at most $50.00; after $150.00 lost or at risk in a day, no new entries (3 full losses).",
    "Entries 09:45–15:30 New York time, up to 3 a day; day trades flat by 15:55.",
  ]);
});
