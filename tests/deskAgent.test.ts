import assert from "node:assert/strict";
import { test } from "node:test";
import { newDesk, normalizeDeskRules, type AgentSession } from "../lib/desk";
import { DESK_TOOLS, toolLabel } from "../lib/data/deskTools";
import { MAX_TOOL_CALLS, runDeskAgent, type DeskClient } from "../lib/deskAgent";

const session = (): AgentSession => ({ id: "S-1", startedAt: new Date().toISOString(), model: "test", status: "running", trigger: "t", steps: [], toolCalls: 0, rounds: 0, usage: { input: 0, output: 0, cacheRead: 0 } });
const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 };
const input = {
  now: "Mon 2026-11-16 10:30 AM New York",
  rules: normalizeDeskRules({ budget: 200 }),
  account: { equity: 200, cash: 200, dailyRoom: 150, tradesLeftToday: 3 },
  candidates: [],
  positions: [],
  recentTrades: [],
};

/** A stand-in for the Messages API that plays back canned turns and records what it was sent. */
function fake(turns: Array<Record<string, unknown>>) {
  const sent: Array<Record<string, unknown>> = [];
  const client = {
    beta: {
      messages: {
        create: async (p: unknown) => {
          sent.push(JSON.parse(JSON.stringify(p)));
          const t = turns.shift();
          if (!t) throw new Error("no more turns");
          return { usage, ...t };
        },
      },
    },
  } as unknown as DeskClient;
  return { client, sent };
}

test("tools: read-only research tools, strict schemas, readable labels", () => {
  assert.deepEqual(DESK_TOOLS.map((t) => t.name).sort(), ["get_daily_chart", "get_desk_history", "get_intraday_chart", "get_levels_and_indicators", "get_market_overview", "get_news_and_events", "get_setup_track_record"]);
  for (const t of DESK_TOOLS) {
    assert.equal(t.strict, true);
    assert.equal((t.input_schema as { additionalProperties?: boolean }).additionalProperties, false);
  }
  assert.equal(toolLabel("get_daily_chart", { symbol: "nvda", days: 120 }), "daily chart NVDA (120d)");
  assert.equal(toolLabel("get_desk_history", { symbol: null }), "desk history (all)");
});

test("loop: runs Claude's tool calls, sends results back, logs every step, returns the decision", async () => {
  const s = newDesk(200, "2026-11-16T15:00:00.000Z");
  const { client, sent } = fake([
    {
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "Check how this desk has done first.", signature: "x" },
        { type: "tool_use", id: "tu1", name: "get_desk_history", input: { symbol: null } },
        { type: "tool_use", id: "tu2", name: "no_such_tool", input: {} },
      ],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ summary: "Nothing worth taking.", positions: [], entries: [] }) }] },
  ]);
  const ss = session();
  let updates = 0;
  const d = await runDeskAgent(input, { nowMs: Date.parse("2026-11-16T15:30:00Z"), today: "2026-11-16", desk: s }, ss, () => updates++, client);
  assert.equal(d.summary, "Nothing worth taking.");
  assert.equal(ss.rounds, 2);
  assert.equal(ss.toolCalls, 2);
  assert.equal(ss.usage.input, 200);
  assert.deepEqual(ss.steps.map((x) => [x.kind, x.title, x.ok]), [
    ["thinking", "Thinking", undefined],
    ["tool", "desk history (all)", true],
    ["tool", "no_such_tool", false],
    ["decision", "Decided: 0 buys, 0 skips, 0 positions reviewed", undefined],
  ]);
  assert.ok(updates >= 4);
  // the second request carries Claude's turn back unchanged (thinking included) and both tool results
  const msgs = sent[1].messages as Array<{ role: string; content: Array<{ type: string; is_error?: boolean; tool_use_id?: string }> }>;
  assert.equal(msgs[1].role, "assistant");
  assert.equal(msgs[1].content[0].type, "thinking");
  assert.deepEqual(msgs[2].content.map((c) => [c.tool_use_id, c.is_error ?? false]), [["tu1", false], ["tu2", true]]);
  assert.equal((sent[0].thinking as { display: string }).display, "summarized");
});

test("loop: the research budget caps tool calls", async () => {
  const s = newDesk(200, "2026-11-16T15:00:00.000Z");
  const many = Array.from({ length: MAX_TOOL_CALLS + 2 }, (_, i) => ({ type: "tool_use", id: `t${i}`, name: "get_desk_history", input: { symbol: null } }));
  const { client, sent } = fake([
    { stop_reason: "tool_use", content: many },
    { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ summary: "", positions: [], entries: [] }) }] },
  ]);
  const ss = session();
  await runDeskAgent(input, { nowMs: Date.now(), today: "2026-11-16", desk: s }, ss, () => {}, client);
  const results = (sent[1].messages as Array<{ content: Array<{ is_error?: boolean }> }>)[2].content;
  assert.equal(results.filter((r) => r.is_error).length, 2);
  assert.equal(ss.toolCalls, MAX_TOOL_CALLS);
});

test("loop: a refusal fails the session instead of trading", async () => {
  const { client } = fake([{ stop_reason: "refusal", content: [] }]);
  await assert.rejects(runDeskAgent(input, { nowMs: Date.now(), today: "2026-11-16", desk: newDesk(200, "2026-11-16T15:00:00.000Z") }, session(), () => {}, client), /declined/);
});
