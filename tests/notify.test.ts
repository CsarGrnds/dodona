import assert from "node:assert/strict";
import { test } from "node:test";
import { openNote, runNote } from "../lib/autoBatch";
import { imessageTo } from "../lib/data/liveRun";

test("iMessage alerts: only a phone number or an email is used as the recipient", () => {
  assert.equal(imessageTo(undefined), undefined);
  assert.equal(imessageTo(""), undefined);
  assert.equal(imessageTo("+1 (555) 123-4567"), "+15551234567");
  assert.equal(imessageTo("me@icloud.com"), "me@icloud.com");
  assert.equal(imessageTo('x" & do shell script "rm'), undefined);
  assert.equal(imessageTo("123"), undefined);
  assert.equal(imessageTo("not an email"), undefined);
});

test("9:35 text: gateway, today's shortlist and the first batch time", () => {
  const shortlist = { date: "2026-11-20", kept: ["REPL", "GDYN", "A", "B", "C", "D", "E"].map((symbol) => ({ symbol })), dropped: [{ symbol: "ADT" }] };
  const times = ["10:00", "11:00", "14:00"];
  const ok = openNote({ date: "2026-11-20", gateway: "ready", shortlist, times, nowMinute: 9 * 60 + 35 });
  assert.match(ok, /^Shortlist: 7 names \(REPL, GDYN, A, B, C, D, …\), ADT dropped on news\. First batch check at 10:00 AM New York/);
  assert.doesNotMatch(ok, /LOGGED OUT/);
  const bad = openNote({ date: "2026-11-21", gateway: "login", shortlist, times, nowMinute: 9 * 60 + 35 });
  assert.match(bad, /LOGGED OUT/);
  assert.match(bad, /No shortlist for today yet/);
  assert.match(openNote({ date: "2026-11-20", gateway: "ready", shortlist, times, nowMinute: 14 * 60 }), /No batch times left today/);
});

test("after each batch check: its report as plain text, cut short", () => {
  const md = "No orders are staged.\n\n- **Market: defensive.** SPY under VWAP.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nSkip logged.";
  assert.equal(runNote(md), "No orders are staged. Market: defensive. SPY under VWAP. Skip logged.");
  assert.ok(runNote("word ".repeat(400)).length <= 700);
  assert.match(runNote(undefined, "gateway down"), /^It failed: gateway down/);
  assert.match(runNote(""), /no report/);
});
