import assert from "node:assert/strict";
import { test } from "node:test";
import { ibkrStopOrder, planStopChange, stopConfirm, stopConfirmMatches, stopTicketLines, type StopFacts } from "../lib/ibkrOrder";

const FACTS: StopFacts = { shares: 10, avgCost: 100, price: 130, noLoss: true, stops: [{ orderId: "77", kind: "stop", stop: 110, qty: 10, tif: "GTC" }] };

test("stop ticket: raises the resting stop, only up, never at the price or under cost", () => {
  const ok = planStopChange("abc", 118.456, FACTS);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.deepEqual(ok.change, { symbol: "ABC", qty: 10, to: 118.45, from: 110, orderId: "77", tif: "GTC" });
    assert.deepEqual(ibkrStopOrder(ok.change, "U1", 42), { acctId: "U1", conid: 42, orderType: "STP", side: "SELL", price: 118.45, quantity: 10, tif: "GTC", outsideRTH: false });
    const lines = stopTicketLines(ok.change, "U1", false, FACTS);
    assert.match(lines[0], /^LIVE account U1/);
    assert.match(lines[1], /CHANGE stop order #77: SELL 10 ABC STOP \$110\.00 → \$118\.45/);
    assert.match(lines[2], /\$184\.50 over your cost/);
    assert.equal(stopConfirm(ok.change), "STOP ABC 118.45");
    assert.ok(stopConfirmMatches(" stop abc $118.45 ", ok.change));
    assert.ok(!stopConfirmMatches("STOP ABC 118.4", ok.change));
  }
  assert.match((planStopChange("ABC", 109, FACTS) as { reason: string }).reason, /only move up/);
  assert.match((planStopChange("ABC", 130, FACTS) as { reason: string }).reason, /fills at once/);
  assert.match((planStopChange("ABC", 95, { ...FACTS, stops: [] }) as { reason: string }).reason, /never to sell at a loss/);
  assert.ok(planStopChange("ABC", 95, { ...FACTS, stops: [], noLoss: false }).ok);
});

test("stop ticket: sets a new stop for whole shares; refuses what Dodona can't change safely", () => {
  const set = planStopChange("ABC", 105, { ...FACTS, shares: 3.6, stops: [] });
  assert.ok(set.ok && set.change.qty === 3 && !set.change.orderId && set.change.tif === "GTC");
  if (set.ok) assert.match(stopTicketLines(set.change, "DU1", true, { ...FACTS, shares: 3.6 }).at(-1)!, /0\.6 fractional shares stay without a stop/);
  assert.match((planStopChange("ABC", 105, { ...FACTS, shares: 0.5, stops: [] }) as { reason: string }).reason, /less than one whole share/);
  assert.match((planStopChange("ABC", 115, { ...FACTS, shares: 0 }) as { reason: string }).reason, /don't hold/);
  assert.match((planStopChange("ABC", 115, { ...FACTS, stops: [...FACTS.stops, { ...FACTS.stops[0], orderId: "78" }] }) as { reason: string }).reason, /2 stop orders/);
  assert.match((planStopChange("ABC", 115, { ...FACTS, stops: [{ ...FACTS.stops[0], kind: "trail" }] }) as { reason: string }).reason, /trail order/);
  assert.match((planStopChange("ABC", 115, { ...FACTS, stops: [{ ...FACTS.stops[0], qty: 12 }] }) as { reason: string }).reason, /sells 12 shares/);
  assert.match((planStopChange("ABC", 115, { ...FACTS, shares: 5.2842, stops: [{ ...FACTS.stops[0], qty: 5.2842 }] }) as { reason: string }).reason, /fractional order/);
});
