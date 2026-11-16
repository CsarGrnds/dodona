import assert from "node:assert/strict";
import { test } from "node:test";
import { countdown, nextBell, nyEpoch } from "../lib/clock";

test("New York wall time → epoch, across daylight saving", () => {
  assert.equal(new Date(nyEpoch("2026-11-16", 9 * 60 + 30)).toISOString(), "2026-11-16T14:30:00.000Z"); // EST, UTC−5
  assert.equal(new Date(nyEpoch("2026-07-01", 16 * 60)).toISOString(), "2026-07-01T20:00:00.000Z"); // EDT, UTC−4
  assert.equal(new Date(nyEpoch("2026-03-09", 9 * 60 + 30)).toISOString(), "2026-03-09T13:30:00.000Z"); // the Monday after the switch
});

test("next bell: weekend → Monday's open; in session → today's close; early close; holiday", () => {
  const sun = nextBell(Date.parse("2026-11-15T23:00:00Z")); // Sunday 6 PM ET
  assert.deepEqual([sun.open, sun.kind, sun.date, sun.label, sun.reason], [false, "open", "2026-11-16", "9:30 AM", "weekend"]);
  assert.equal(sun.at, Date.parse("2026-11-16T14:30:00Z"));
  const mid = nextBell(Date.parse("2026-11-16T17:00:00Z")); // Monday noon ET
  assert.deepEqual([mid.open, mid.kind, mid.label], [true, "close", "4:00 PM"]);
  assert.equal(mid.at, Date.parse("2026-11-16T21:00:00Z"));
  const early = nextBell(Date.parse("2026-11-27T15:00:00Z")); // day after Thanksgiving, 10 AM ET
  assert.deepEqual([early.label, early.early], ["1:00 PM", "day after Thanksgiving"]);
  const thanks = nextBell(Date.parse("2026-11-26T15:00:00Z")); // Thanksgiving
  assert.deepEqual([thanks.open, thanks.date], [false, "2026-11-27"]);
  assert.match(thanks.reason, /Thanksgiving/);
  const after = nextBell(Date.parse("2026-11-16T21:30:00Z")); // Monday 4:30 PM ET
  assert.deepEqual([after.kind, after.date, after.reason], ["open", "2026-11-17", "after the close"]);
});

test("countdown format", () => {
  assert.equal(countdown(((2 * 24 + 4) * 60 + 5) * 60_000), "2d 4h 05m");
  assert.equal(countdown((3 * 60 + 5) * 60_000 + 59_000), "3h 05m");
  assert.equal(countdown(42 * 60_000 + 8_000), "42m 08s");
  assert.equal(countdown(8_400), "8s");
  assert.equal(countdown(-5), "0s");
});
