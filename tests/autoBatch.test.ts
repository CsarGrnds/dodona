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

test("auto batch: the next run for the countdown, skipping weekends and holidays", async () => {
  const { nextAutoRun } = await import("../lib/autoBatch");
  const times = ["10:00", "13:00"];
  const wed1130 = Date.parse("2026-11-18T16:30:00Z"); // Wed 11:30 New York
  const a = nextAutoRun(wed1130, times)!;
  assert.deepEqual([a.time, a.dayLabel, (a.at - wed1130) / 60_000], ["13:00", "today", 90]);
  const wed1400 = Date.parse("2026-11-18T19:00:00Z");
  assert.deepEqual([nextAutoRun(wed1400, times)!.time, nextAutoRun(wed1400, times)!.dayLabel], ["10:00", "tomorrow"]);
  const fri1400 = Date.parse("2026-11-20T19:00:00Z");
  assert.equal(nextAutoRun(fri1400, times)!.dayLabel, "Monday");
  const wedBeforeThanksgiving = Date.parse("2026-11-25T19:00:00Z"); // Thanksgiving 2026-11-26 is closed
  assert.equal(nextAutoRun(wedBeforeThanksgiving, times)!.dayLabel, "Friday");
  assert.equal(nextAutoRun(wed1130, []), undefined);
});
