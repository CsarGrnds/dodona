import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmMatches, confirmPhrase, ibkrBracket, ibkrMoney, ibkrWarning, isPaperAccount, maxLossOf, nyIso, parsePlaceAnswer, ticketLines } from "../lib/ibkrOrder";
import { validateRules } from "../lib/settings";

const PLAN = { symbol: "TSLA", qty: 8, stop: 358.32, target: 370.04, entry: 364.18 };

test("ibkr: trader-budget's bracket becomes a parent buy and two linked children", () => {
  const [buy, tp, sl] = ibkrBracket(PLAN, "DU1234567", 76792991, "dodona-abc");
  assert.deepEqual(buy, { acctId: "DU1234567", conid: 76792991, quantity: 8, tif: "DAY", outsideRTH: false, cOID: "dodona-abc", side: "BUY", orderType: "MKT" });
  assert.deepEqual([tp.parentId, tp.side, tp.orderType, tp.price, tp.quantity], ["dodona-abc", "SELL", "LMT", 370.04, 8]);
  assert.deepEqual([sl.parentId, sl.side, sl.orderType, sl.price, sl.quantity], ["dodona-abc", "SELL", "STP", 358.32, 8]);
  assert.equal(tp.cOID, undefined, "IBKR: children of a bracket carry no cOID");
  assert.equal(sl.cOID, undefined);
  const [lim] = ibkrBracket({ ...PLAN, limit: 364 }, "DU1", 1, "x");
  assert.deepEqual([lim.orderType, lim.price], ["LMT", 364]);
  assert.throws(() => ibkrBracket({ ...PLAN, qty: 2.5 }, "DU1", 1, "x"), /whole shares/);
  assert.throws(() => ibkrBracket({ ...PLAN, stop: 371 }, "DU1", 1, "x"), /stop/);
  assert.throws(() => ibkrBracket({ ...PLAN, limit: 371 }, "DU1", 1, "x"), /limit/);
});

test("ibkr: paper accounts, the ticket and the typed confirmation", () => {
  assert.ok(isPaperAccount("DU1234567"));
  assert.ok(!isPaperAccount("U1234567"));
  assert.ok(!isPaperAccount(undefined));
  assert.deepEqual(ticketLines(PLAN, "DU1234567", true), [
    "PAPER account DU1234567, Interactive Brokers",
    "BUY 8 TSLA, market, good for today",
    "stop-loss $358.32 · take-profit $370.04 (one cancels the other)",
    "max loss about $46.88 if the stop fills at $358.32; in a fast market it can fill worse",
  ]);
  assert.equal(confirmPhrase(PLAN), "8 TSLA");
  assert.ok(confirmMatches(" 8  tsla ", PLAN));
  assert.ok(!confirmMatches("yes", PLAN));
  assert.ok(!confirmMatches("80 TSLA", PLAN));
});

test("ibkr: IBKR's answers are read as placed orders or questions for you, never auto-confirmed", () => {
  assert.deepEqual(parsePlaceAnswer([{ order_id: "1234", order_status: "PreSubmitted", local_order_id: "dodona-abc" }]), { placed: [{ orderId: "1234", status: "PreSubmitted", cOID: "dodona-abc" }], questions: [] });
  assert.deepEqual(parsePlaceAnswer([{ id: "q-1", message: ["You are submitting an order without market data."], isSuppressed: false }]), { placed: [], questions: [{ id: "q-1", messages: ["You are submitting an order without market data."] }] });
  assert.equal(parsePlaceAnswer({ error: "Order size exceeds" }).error, "Order size exceeds");
  assert.deepEqual(parsePlaceAnswer(null), { placed: [], questions: [] });
});

test("ibkr: the log's New York time matches trader-broker's", () => {
  assert.equal(nyIso(Date.parse("2026-10-19T14:15:00Z")), "2026-10-19T10:15:00-04:00");
  assert.equal(nyIso(Date.parse("2026-11-17T15:00:00Z")), "2026-11-17T10:00:00-05:00");
});

test("settings: the broker is a choice, sending orders a switch", () => {
  assert.ok(validateRules({ broker: "ibkr", ibkr_orders: true }).ok);
  const r = validateRules({ broker: "robinhood", ibkr_orders: "yes" });
  assert.ok(!r.ok);
  if (!r.ok) assert.deepEqual(Object.keys(r.errors).sort(), ["broker", "ibkr_orders"]);
});

test("ibkr: money and warnings as IBKR's what-if writes them (seen live)", () => {
  assert.equal(ibkrMoney("11.36 USD (1 Shares)"), 11.36);
  assert.equal(ibkrMoney("0.12 USD"), 0.12);
  assert.equal(ibkrMoney("1,234.50 USD"), 1234.5);
  assert.equal(ibkrMoney(undefined), undefined);
  assert.equal(ibkrWarning("20/You are trying to submit an order without having market data for this instrument. \nIB strongly recommends"), "You are trying to submit an order without having market data for this instrument. IB strongly recommends");
});

test("ibkr: a buy-stop entry waits for the breakout, with a sell at the close", () => {
  const plan = { ...PLAN, trigger: 364.18, closeAtEnd: true };
  const orders = ibkrBracket(plan, "U1", 7, "dodona-x");
  assert.deepEqual(orders.map((o) => [o.side, o.orderType, o.price, o.parentId]), [
    ["BUY", "STP", 364.18, undefined],
    ["SELL", "LMT", 370.04, "dodona-x"],
    ["SELL", "STP", 358.32, "dodona-x"],
    ["SELL", "MOC", undefined, "dodona-x"],
  ]);
  assert.equal(maxLossOf({ ...PLAN, trigger: 365 }), 53.44); // measured from the higher trigger
  assert.throws(() => ibkrBracket({ ...PLAN, trigger: 371 }, "U1", 1, "x"), /trigger/);
  assert.throws(() => ibkrBracket({ ...PLAN, trigger: 364, limit: 364 }, "U1", 1, "x"), /not both/);
  assert.match(ticketLines(plan, "U1", false)[1], /when it trades at \$364\.18 or higher \(buy-stop/);
  assert.match(ticketLines(plan, "U1", false)[2], /sold at the close/);
});

test("ibkr: a batch is confirmed by typing every order", () => {
  const batch = [{ qty: 8, symbol: "TSLA" }, { qty: 5, symbol: "f" }];
  assert.equal(confirmPhrase(batch), "8 TSLA, 5 F");
  assert.ok(confirmMatches("8 tsla,5 f", batch));
  assert.ok(!confirmMatches("8 TSLA", batch));
  assert.ok(!confirmMatches("5 F, 8 TSLA", batch));
});

test("ibkr: fees may be at most a quarter of the risk (IBKR's $1 minimum, seen live)", async () => {
  const { ibkrFeeEstimate, feeProblem } = await import("../lib/ibkrOrder");
  assert.equal(ibkrFeeEstimate(13, 11.5), 2); // $1.00 each way, as the preview charged
  assert.equal(ibkrFeeEstimate(500, 20), 5); // $0.005 a share
  assert.match(feeProblem({ symbol: "F", qty: 13, entry: 11.5, trigger: 11.5, stop: 11.2, target: 12.1 }) ?? "", /\$2\.00 in IBKR commissions .* \$3\.90 of risk/);
  assert.equal(feeProblem(PLAN), undefined); // 8 TSLA: $2 against $46.88
});
