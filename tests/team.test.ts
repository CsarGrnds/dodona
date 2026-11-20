import assert from "node:assert/strict";
import { test } from "node:test";
import { newDesk, openPosition } from "../lib/desk";
import { acceptBatch } from "../lib/data/ibkrOrders";
import { acceptTeamOrder, brokerState, orderFingerprint, paperPortfolio } from "../lib/data/paper";
import { exitAnswer, firstPrompt, isSessionId, projectSlug, stepsFrom, teamModels, usageFrom } from "../lib/data/transcripts";

test("any Claude Code session: its first prompt as the title, and only real session ids", () => {
  const head = [
    JSON.stringify({ timestamp: "2026-11-17T10:00:00Z", type: "summary" }),
    JSON.stringify({ timestamp: "2026-11-17T10:00:01Z", message: { role: "user", content: "<command-name>/clear</command-name>" } }),
    JSON.stringify({ timestamp: "2026-11-17T10:00:02Z", message: { role: "user", content: [{ type: "text", text: "<system-reminder>x</system-reminder> run the trade desk" }] } }),
  ].join("\n");
  assert.deepEqual(firstPrompt(head), { title: "run the trade desk", startedAt: "2026-11-17T10:00:00Z" });
  assert.ok(isSessionId("a57fdd65-2c13-4278-be31-ff222ab21811"));
  assert.ok(!isSessionId("../../etc/passwd"));
  const { steps } = stepsFrom([{ timestamp: "2026-11-17T10:00:03Z", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "mcp__Claude_Browser__read_page", input: {} }] } }], "lead");
  assert.equal(steps[0].title, "Claude Browser · read page");
});

test("each specialist runs on a model sized to its job", async () => {
  const m = await teamModels();
  assert.deepEqual(
    Object.fromEntries(Object.entries(m).sort()),
    { "trade-analyst": "sonnet", "trade-budget": "haiku", "trade-chartist": "sonnet", "trade-coach": "opus", "trade-entry": "haiku", "trade-exit": "haiku", "trade-news": "sonnet", "trade-risk": "haiku", "trade-scanner": "haiku", "trade-screener": "sonnet", "trade-timemachine": "haiku" },
  );
});

test("usage: tokens and API cost per agent, one response counted once", () => {
  const msg = (id: string, model: string, usage: Record<string, unknown>) => ({ timestamp: "2026-11-16T15:00:00Z", message: { role: "assistant", id, model, usage, content: [] } });
  const opus = usageFrom([
    msg("m1", "claude-opus-5-5", { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2000, cache_creation: { ephemeral_1h_input_tokens: 2000 } }),
    msg("m1", "claude-opus-5-5", { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2000, cache_creation: { ephemeral_1h_input_tokens: 2000 } }),
  ])!;
  // 1000×$4 + 10,000×$0.40 + 2000×$8 (1-hour write) + 1000×$20, per million
  assert.equal(opus.calls, 1);
  assert.equal(opus.costUsd, 0.044);
  const haiku = usageFrom([msg("h1", "claude-haiku-5-5", { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2000, cache_creation: { ephemeral_1h_input_tokens: 2000 } })])!;
  assert.equal(haiku.costUsd, 0.0011);
  assert.equal(usageFrom([msg("x", "claude-unknown-9", { input_tokens: 5, output_tokens: 5 })])!.costUsd, undefined);
  assert.equal(usageFrom([]), undefined);
});

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

test("a trader skill's exit 1 is its answer (nothing new, not triggered), a crash is still an error", () => {
  assert.equal(exitAnswer("news.py", 'Exit code 1\n{"moves": []}'), "nothing new");
  assert.equal(exitAnswer("check.py", "Exit code 1\nBLOCK TSLA: over the daily limit"), "BLOCK");
  assert.equal(exitAnswer("news.py", "Exit code 1\nTraceback (most recent call last):\n  KeyError"), undefined);
  assert.equal(exitAnswer("news.py", "Exit code 2\nnews: no tickers"), undefined);
  assert.equal(exitAnswer(undefined, "Exit code 1"), undefined);
  const cmd = 'cd trader/paper && python3 "/x/.claude/skills/trader-news/news.py" --json';
  const { steps } = stepsFrom([
    { timestamp: "2026-11-20T14:16:20Z", message: { role: "assistant", content: [{ type: "tool_use", id: "n", name: "Bash", input: { command: cmd } }] } },
    { timestamp: "2026-11-20T14:16:29Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "n", is_error: true, content: 'Exit code 1\n{"moves": []}' }] } },
  ], "trade-screener");
  assert.equal(steps[1].title, "/trader-news · news.py → nothing new");
  assert.equal(steps[1].ok, true);
});

test("ibkr batch: every order must PASS trader-risk, recently, as buy brackets in different stocks", () => {
  const now = Date.parse("2026-11-18T15:00:00Z");
  const stopEntry = { ...ORDER, type: "stop", stop_price: "364.18" };
  const F = { ...ORDER, symbol: "F", qty: "5", stop_loss_stop_price: "11.00", take_profit_limit_price: "12.00", type: "stop", stop_price: "11.40", plan: { entry: 11.4, stop: 11, target: 12 } };
  const risk = (orders: Array<Record<string, unknown>>, verdicts: string[], at = "2026-11-18T14:55:00Z") => ({ checked_at: at, results: orders.map((o, i) => ({ fingerprint: orderFingerprint(o), verdict: verdicts[i], reasons: verdicts[i] === "BLOCK" ? ["over the daily limit"] : [] })) });
  const ok = acceptBatch({ orders: [stopEntry, F] }, risk([stopEntry, F], ["PASS", "PASS"]), now);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.deepEqual(ok.items.map((x) => [x.plan.symbol, x.plan.qty, x.plan.trigger, x.plan.closeAtEnd, x.maxLoss]), [["TSLA", 8, 364.18, true, 46.88], ["F", 5, 11.4, true, 2]]);
  }
  const why = (r: ReturnType<typeof acceptBatch>) => (r.ok ? "" : r.reason);
  assert.match(why(acceptBatch({ orders: [stopEntry, F] }, risk([stopEntry, F], ["PASS", "BLOCK"]), now)), /F: trader-risk said BLOCK/);
  assert.match(why(acceptBatch({ orders: [stopEntry, F] }, risk([stopEntry], ["PASS"]), now)), /F: trader-risk checked a different order/);
  assert.match(why(acceptBatch({ orders: [stopEntry, stopEntry] }, risk([stopEntry, stopEntry], ["PASS", "PASS"]), now)), /twice/);
  assert.match(why(acceptBatch({ orders: [stopEntry] }, risk([stopEntry], ["PASS"], "2026-11-18T14:00:00Z"), now)), /minutes old/);
  assert.match(why(acceptBatch({ orders: [{ ...stopEntry, type: "trailing_stop" }] }, risk([{ ...stopEntry, type: "trailing_stop" }], ["PASS"]), now)), /isn't supported/);
  assert.match(why(acceptBatch({ orders: [{ ...stopEntry, side: "sell" }] }, risk([{ ...stopEntry, side: "sell" }], ["PASS"]), now)), /only buys/);
});
