import assert from "node:assert/strict";
import { test } from "node:test";
import { newDesk, openPosition } from "../lib/desk";
import { acceptTeamOrder, brokerState, orderFingerprint, paperPortfolio } from "../lib/data/paper";
import { projectSlug, stepsFrom } from "../lib/data/transcripts";

const ORDER = {
  symbol: "TSLA", side: "buy", qty: "8", type: "market", time_in_force: "day", order_class: "bracket",
  take_profit_limit_price: "370.04", stop_loss_stop_price: "358.32", why: "x",
  plan: { entry: 364.18, stop: 358.32, target: 370.04, setup: "orb", flat_by: "15:55", max_loss: 46.88 },
};

test("order fingerprint matches trader-risk's check.py", () => {
  // python3 -c "import check; print(check.fingerprint({...the same order...}))" → c38dc9bf3e621b26
  assert.equal(orderFingerprint(ORDER), "c38dc9bf3e621b26");
  // notes that are never sent to the broker don't change it
  assert.equal(orderFingerprint({ ...ORDER, why: "other", plan: {} }), "c38dc9bf3e621b26");
  assert.notEqual(orderFingerprint({ ...ORDER, qty: "9" }), "c38dc9bf3e621b26");
});

test("the desk books only the exact order trader-risk passed, recently", () => {
  const now = Date.parse("2026-11-16T15:20:00Z");
  const risk = (verdict: string, fp = "c38dc9bf3e621b26", at = "2026-11-16T15:15:00Z") => ({ checked_at: at, results: [{ fingerprint: fp, verdict, reasons: verdict === "BLOCK" ? ["over the daily limit"] : [] }] });
  const ok = acceptTeamOrder({ orders: [ORDER] }, risk("PASS"), now);
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual([ok.order.symbol, ok.order.qty, ok.order.stop, ok.order.target, ok.order.entry, ok.order.setup], ["TSLA", 8, 358.32, 370.04, 364.18, "orb"]);
  const why = (r: ReturnType<typeof acceptTeamOrder>) => (r.ok ? "" : r.reason);
  assert.match(why(acceptTeamOrder({ orders: [ORDER] }, risk("BLOCK"), now)), /BLOCK: over the daily limit/);
  assert.match(why(acceptTeamOrder({ orders: [{ ...ORDER, qty: "20" }] }, risk("PASS"), now)), /different order/);
  assert.match(why(acceptTeamOrder({ orders: [ORDER] }, risk("PASS", undefined, "2026-11-16T14:00:00Z"), now)), /minutes old/);
  assert.match(why(acceptTeamOrder({ orders: [ORDER] }, null, now)), /no trader-risk check/);
  assert.match(why(acceptTeamOrder({ orders: [ORDER, ORDER] }, risk("PASS"), now)), /exactly one/);
  assert.match(why(acceptTeamOrder({ orders: [{ ...ORDER, side: "sell" }] }, risk("PASS"), now)), /only books buys/);
  assert.match(why(acceptTeamOrder({ orders: [{ ...ORDER, order_class: "simple" }] }, risk("PASS"), now)), /bracket/);
});

test("the paper workspace mirrors the paper account, not the real one", () => {
  const s = newDesk(200, "2026-11-16T15:00:00.000Z");
  openPosition(s, { symbol: "F", style: "day", setup: "orb", qty: 5, entry: 12, stop: 11.5, target: 13, openedAt: "2026-11-16T15:00:00.000Z", entryDate: "2026-11-16", maxHoldDays: 1, by: "team", thesis: "t" }, "2026-11-16T15:00:00.000Z");
  const pf = paperPortfolio(s);
  assert.equal(pf.cash, 200 - 60 - 0.35);
  assert.deepEqual(pf.positions.map((p) => [p.ticker, p.shares]), [["F", 5]]);
  const st = brokerState(s, "2026-11-10");
  assert.deepEqual(st.orders.map((o) => [o.symbol, o.side, o.kind, o.status, o.date, o.max_loss]), [["F", "buy", "entry", "placed", "2026-11-16", 2.5]]);
  assert.equal(brokerState(s, "2026-11-17").orders.length, 0);
});

test("transcripts: the lead's steps, delegations and the subagents' reports", () => {
  assert.equal(projectSlug("/Users/me/Github/dodona"), "-Users-me-Github-dodona");
  const t = (s: number) => new Date(Date.parse("2026-11-16T15:00:00Z") + s * 1000).toISOString();
  const recs = [
    { timestamp: t(0), message: { role: "assistant", content: [{ type: "thinking", thinking: "Scan first." }, { type: "tool_use", id: "a1", name: "Bash", input: { command: "npm run desk -- session start --trigger x" } }] } },
    { timestamp: t(1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: "{\"ok\":true}" }] } },
    { timestamp: t(2), message: { role: "assistant", content: [{ type: "tool_use", id: "a2", name: "Agent", input: { subagent_type: "trade-timemachine", description: "Odds for F", prompt: "Run it" } }] } },
    { timestamp: t(40), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a2", content: [{ type: "text", text: "VERDICT: coin flip" }] }] } },
    { timestamp: t(41), message: { role: "assistant", content: [{ type: "tool_use", id: "a3", name: "Bash", input: { command: "cd trader/paper && python3 ../../.claude/skills/trader-risk/check.py --json" } }] } },
    { timestamp: t(42), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a3", is_error: true, content: "boom" }] } },
  ];
  const { steps, delegates } = stepsFrom(recs, "lead");
  assert.deepEqual(steps.map((s) => [s.agent, s.kind, s.title]), [
    ["lead", "thinking", "Thinking"],
    ["lead", "command", "desk session start"],
    ["lead", "output", "desk session start → done"],
    ["lead", "delegate", "→ trade-timemachine: Odds for F"],
    ["trade-timemachine", "report", "trade-timemachine reported"],
    ["lead", "skill", "/trader-risk · check.py"],
    ["lead", "output", "/trader-risk · check.py → error"],
  ]);
  assert.equal(steps[4].detail, "VERDICT: coin flip");
  assert.equal(steps[6].ok, false);
  assert.deepEqual(delegates.map((d) => d.agent), ["trade-timemachine"]);
});
