import assert from "node:assert/strict";
import { test } from "node:test";
import { dueSlot, parseAutoTimes } from "../lib/autoBatch";

test("auto batch: the user's times, inside the window, each once a day", () => {
  assert.deepEqual(parseAutoTimes("9:47, 11:00,13:00; 08:30 16:00 nonsense 11:00"), ["09:47", "11:00", "13:00"]);
  const times = ["09:47", "11:00"];
  assert.equal(dueSlot(times, 9 * 60 + 46, []), undefined, "not before its minute");
  assert.equal(dueSlot(times, 9 * 60 + 47, []), "09:47");
  assert.equal(dueSlot(times, 9 * 60 + 55, []), "09:47", "a few minutes late still runs");
  assert.equal(dueSlot(times, 9 * 60 + 57, []), undefined, "not 10 minutes later");
  assert.equal(dueSlot(times, 9 * 60 + 50, ["09:47"]), undefined, "once a day");
  assert.equal(dueSlot(times, 11 * 60 + 2, ["09:47"]), "11:00");
});
