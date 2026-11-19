import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkProfile, orderRule, parseProfile } from "../lib/agentProfile";
import { TEAM } from "../lib/settings";

const read = (a: string) => readFileSync(`.claude/agents/${a}.md`, "utf8");

test("agent profiles: every team file parses and passes its own checks", () => {
  for (const { agent } of TEAM) {
    const t = read(agent);
    const p = parseProfile(t);
    assert.equal(p?.name, agent);
    assert.ok(orderRule(t), `${agent} has the NEVER AN ORDER rule`);
    assert.deepEqual(checkProfile(agent, t, t), [], agent);
  }
});

test("agent profiles: edits that break the team or its safety rules are refused", () => {
  const t = read("trade-news");
  const errs = (next: string) => checkProfile("trade-news", next, t).join(" | ");
  assert.equal(errs(t + "\n- Be brief.\n"), ""); // a plain edit to the instructions is fine
  assert.match(errs(t.replace(/^name: .*$/m, "name: trade-other")), /name: must stay/);
  assert.match(errs(t.replace(/^model: .*$/m, "model: gpt")), /model: one of/);
  assert.match(errs(t.replace(/^tools: .*$/m, "tools: Bash, Read, WebFetch")), /WebFetch not allowed/);
  assert.match(errs(t.replace(/^tools: .*$/m, "tools: Bash, Edit")), /Edit not allowed/);
  assert.equal(checkProfile("trade-coach", read("trade-coach"), read("trade-coach")).length, 0); // the coach may Edit/Write
  assert.match(errs(t.replace(orderRule(t)!, "- Orders are fine.")), /NEVER AN ORDER/);
  assert.match(errs(t.replace(/^---\n/, "")), /frontmatter/);
  assert.match(errs(t + "x".repeat(70_000)), /too long/);
});
