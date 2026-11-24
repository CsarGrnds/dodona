import assert from "node:assert/strict";
import { test } from "node:test";
import { dueSlot, freshReady, parseAutoTimes, watchSlot, watchTimes } from "../lib/autoBatch";
import { validateRules } from "../lib/settings";

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

test("watch: a slot every N minutes from 9:46 to 15:00 New York", () => {
  const at = (h: number, m: number) => h * 60 + m;
  assert.equal(watchSlot(at(9, 45), 10), undefined); // the range isn't formed yet
  assert.equal(watchSlot(at(9, 46), 10), "watch-09:46");
  assert.equal(watchSlot(at(9, 55), 10), "watch-09:46");
  assert.equal(watchSlot(at(9, 56), 10), "watch-09:56");
  assert.equal(watchSlot(at(15, 0), 10), "watch-14:56");
  assert.equal(watchSlot(at(15, 1), 10), undefined);
  assert.equal(watchSlot(at(10, 0), 0), undefined); // off
  const t = watchTimes(10);
  assert.equal(t[0], "09:46");
  assert.equal(t.at(-1), "14:56");
  assert.equal(t.length, 32);
});

test("watch: only ranges the team hasn't worked today wake it", () => {
  assert.deepEqual(freshReady(["F", "KO"], ["F"]), ["KO"]);
  assert.deepEqual(freshReady(["f"], ["F"]), []);
  // the setting: 0 is off, otherwise at least 5 minutes
  assert.ok(validateRules({ watch_every_min: "10" }).ok);
  assert.ok(validateRules({ watch_every_min: "0" }).ok);
  const bad = validateRules({ watch_every_min: "2" });
  assert.ok(!bad.ok && bad.errors.watch_every_min);
});
