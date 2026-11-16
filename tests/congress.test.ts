import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { amountLabel, flatten, iso, layoutLines, memberMatch, mostBought, parseIndex, parsePtrText, type Ptr } from "../lib/congress";
import { unzipXml } from "../lib/data/congress";
import { gatewayToPortfolio } from "../lib/data/ibkr";

// pdf.js text items from a real House PTR (Filing ID #20035780), positions as pdf.js reports them.
const NUL = "\u0000\u0000\u0000";
const items = [
  [21.7, 594.0, 33.0, "Name:"],
  [99.0, 594.0, 79.4, "Hon. Nancy Pelosi"],
  [21.7, 562.5, 71.7, "State/District:"],
  [99.0, 562.5, 21.2, "CA11"],
  [25.3, 503.3, 12.1, "ID"],
  [65.8, 503.3, 32.7, "Owner"],
  [104.8, 503.3, 26.0, "Asset"],
  [262.3, 503.3, 58.6, "Transaction"],
  [326.8, 503.3, 22.7, "Date"],
  [65.7, 459.0, 10.5, "SP"],
  [104.7, 459.0, 146.2, "Warner Bros. Discovery, Inc. - Series"],
  [104.7, 448.5, 118.8, "A Common Stock (WBD) [ST]"],
  [262.2, 459.0, 5.0, "S"],
  [326.7, 459.0, 48.5, "10/07/2026"],
  [381.4, 459.0, 48.5, "10/07/2026"],
  [445.9, 459.0, 38.6, "$50,001 -"],
  [445.9, 448.5, 39.4, "$100,000"],
  [104.6, 431.3, 75.6, `F${NUL} S${NUL}: New`],
  [104.6, 418.5, 350.3, `D${NUL}${NUL}: Cash proceeds from Warner Bros Discovery merger with Paramount Skydance.`],
  [25.5, 394.5, 424.0, "* For the complete list of asset type abbreviations, please visit https://fd.house.gov/reference/asset-type-codes.aspx."],
  [21.7, 261.0, 76.4, "Digitally Signed:"],
  [100.4, 261.0, 127.6, "Hon. Nancy Pelosi , 11/06/2026"],
  [483.8, 711.8, 84.7, "Filing ID #20035780"],
].map(([x, y, width, str]) => ({ x: x as number, y: y as number, width: width as number, str: str as string }));

test("a House PTR read through pdf.js becomes the same rows as /trader-pelosi", () => {
  const r = parsePtrText(layoutLines(items).join("\n"));
  assert.equal(r.name, "Hon. Nancy Pelosi");
  assert.equal(r.docId, "20035780");
  assert.equal(r.filed, "2026-11-06");
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.owner, "SP");
  assert.equal(t.ownerName, "spouse");
  assert.equal(t.ticker, "WBD");
  assert.equal(t.assetType, "ST");
  assert.equal(t.asset, "Warner Bros. Discovery, Inc. - Series A Common Stock");
  assert.equal(t.typeName, "sale");
  assert.equal(t.date, "2026-10-07");
  assert.equal(t.amount, "$50,001 - $100,000");
  assert.equal(t.amountLow, 50001);
  assert.equal(t.amountHigh, 100000);
  assert.equal(t.daysToDisclose, 30);
  assert.equal(t.late, false);
  assert.match(t.description!, /Paramount Skydance/);
  assert.equal(amountLabel(t), "$50K–$100K");
});

test("options, shares and late filings are read from the description", () => {
  const text = [
    "SP   NVIDIA Corporation (NVDA) [OP]   P   01/16/2026   01/16/2026   $1,000,001 -",
    "                                                                    $5,000,000",
    "     D: Purchased 50 call options with a strike price of $80 and an expiration date of 1/16/2027.",
    "",
    "     Apple Inc. (AAPL) [ST]   S (partial)   01/02/2026   01/02/2026   $15,001 - $50,000",
    "     D: Sold 100 shares.",
  ].join("\n");
  const r = parsePtrText(text, "2026-03-01");
  assert.equal(r.trades.length, 2);
  assert.deepEqual(r.trades[0].option, { contracts: 50, kind: "call", strike: 80, expires: "2027-01-16", exercised: false });
  assert.equal(r.trades[0].amount, "$1,000,001 - $5,000,000");
  assert.equal(r.trades[1].typeName, "partial sale");
  assert.equal(r.trades[1].owner, "");
  assert.equal(r.trades[1].daysToDisclose, 58);
  assert.ok(r.trades[1].late, "over 45 days is late");
});

test("index: parse, member match, newest first; unzip a deflated ZIP", () => {
  const xml = `<FinancialDisclosure>
    <Member><Prefix>Hon.</Prefix><Last>Pelosi</Last><First>Nancy</First><Suffix /><FilingType>P</FilingType><StateDst>CA11</StateDst><Year>2026</Year><FilingDate>8/21/2026</FilingDate><DocID>20035143</DocID></Member>
    <Member><Prefix>Hon.</Prefix><Last>Pelosi</Last><First>Nancy</First><Suffix /><FilingType>P</FilingType><StateDst>CA11</StateDst><Year>2026</Year><FilingDate>11/6/2026</FilingDate><DocID>20035780</DocID></Member>
    <Member><Prefix /><Last>Gottheimer</Last><First>Josh</First><Suffix /><FilingType>O</FilingType><StateDst>NJ05</StateDst><Year>2026</Year><FilingDate>5/15/2026</FilingDate><DocID>10070000</DocID></Member>
  </FinancialDisclosure>`;
  const rows = parseIndex(xml, 2026);
  assert.equal(rows[0].docId, "20035780");
  assert.equal(rows[0].url, "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035780.pdf");
  assert.ok(memberMatch(rows[0], "pelosi") && memberMatch(rows[0], "Nancy Pelosi") && memberMatch(rows[0], "Pelosi, Nancy"));
  assert.ok(!memberMatch(rows[0], "Paul Pelosi"));
  assert.equal(iso("2/30/2026"), undefined);

  // a one-file ZIP, deflated, like the Clerk's <YEAR>FD.zip
  const name = Buffer.from("2026FD.xml");
  const data = Buffer.from(xml);
  const comp = deflateRawSync(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = 30 + name.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  const zip = Buffer.concat([local, name, comp, central, name, eocd]);
  assert.equal(unzipXml(zip), xml);
});

test("most bought ranks tickers by how many members bought", () => {
  const t = (ticker: string, type: string) => ({ owner: "", ownerName: "self", asset: ticker, ticker, type, typeName: type, amount: "" });
  const ptr = (name: string, trades: ReturnType<typeof t>[]): Ptr => ({ docId: name, name, district: "", url: "", scanned: false, trades });
  const rows = flatten([ptr("A", [t("NVDA", "P"), t("MSFT", "P"), t("MSFT", "P")]), ptr("B", [t("NVDA", "P"), t("AAPL", "S")])]);
  const top = mostBought(rows);
  assert.deepEqual(top[0], { ticker: "NVDA", members: 2, buys: 2, sells: 0 });
  assert.equal(top[1].ticker, "MSFT");
  assert.ok(!top.some((x) => x.ticker === "AAPL"), "sold only: not 'bought'");
});

test("IBKR gateway positions + summary map to the same portfolio as the connector", () => {
  const pf = gatewayToPortfolio(
    [
      { conid: 265598, contractDesc: "AAPL", position: 10, mktPrice: 356.27, mktValue: 3562.7, avgCost: 200, avgPrice: 200, unrealizedPnl: 1562.7, assetClass: "STK" },
      { conid: 1, contractDesc: "CLOSED", position: 0, mktPrice: 1, mktValue: 0, assetClass: "STK" },
    ],
    { netliquidation: { amount: 12000, currency: "USD" }, totalcashvalue: { amount: 2500 }, grosspositionvalue: { amount: 3562.7 }, buyingpower: { amount: 5000 } },
    new Date("2026-11-15T12:00:00Z"),
  );
  assert.equal(pf.positions.length, 1, "closed rows are dropped");
  assert.equal(pf.positions[0].ticker, "AAPL");
  assert.equal(pf.positions[0].avgCost, 200);
  assert.equal(pf.positions[0].conid, 265598);
  assert.equal(pf.netLiquidation, 12000);
  assert.equal(pf.cash, 2500);
  assert.equal(pf.buyingPower, 5000);
  assert.equal(pf.syncedAt, "2026-11-15T12:00:00.000Z");
});
