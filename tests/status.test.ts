import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseGoogleQuote } from "../lib/data/google";
import { overall, SKILL_DEPS, skillHealth, timed, type StatusCheck } from "../lib/status";

test("Google Finance: the embedded quote data (2026 markup), and the old attribute as a fallback", () => {
  const html = `<script>AF_initDataCallback({key: 'ds:2', data:[[[["/g/x",["SPY","NYSEARCA"],"State Street SPDR S\\u0026P 500 ETF Trust",5,"USD",[754.37,-2.75,-0.36321852,2,2,2],null,757.12,"#213f31"]]]]});</script>`;
  const q = parseGoogleQuote(html, "SPY", "NYSEARCA")!;
  assert.equal(q.name, "State Street SPDR S&P 500 ETF Trust");
  assert.equal(q.price, 754.37);
  assert.equal(q.change, -2.75);
  assert.ok(Math.abs(q.changePct! + 0.0036321852) < 1e-12);
  assert.equal(q.prevClose, 757.12);
  assert.equal(q.currency, "USD");
  assert.equal(parseGoogleQuote(html, "SPY", "NASDAQ"), null, "another exchange's quote isn't taken");
  const old = parseGoogleQuote(`<div data-last-price="101.5" data-currency-code="USD"></div><div>Previous close</div><div>$100.00</div>`, "X", "NYSE")!;
  assert.equal(old.price, 101.5);
  assert.equal(old.change, 1.5);
});

test("status: overall state, timeouts and thrown errors become rows", async () => {
  const row = (state: StatusCheck["state"]): StatusCheck => ({ key: state, group: "Local", name: state, state, detail: "", usedBy: "" });
  assert.equal(overall([row("ok"), row("off")]).state, "ok", "not configured isn't a failure");
  assert.equal(overall([row("ok"), row("warn")]).state, "warn");
  assert.deepEqual(overall([row("ok"), row("fail"), row("warn")]).counts, { ok: 1, warn: 1, fail: 1, off: 0 });
  const base = { key: "k", group: "Local" as const, name: "n", usedBy: "" };
  const boom = await timed(base, async () => {
    throw new Error("nope");
  });
  assert.equal(boom.state, "fail");
  assert.equal(boom.detail, "nope");
  const slow = await timed(base, () => new Promise((r) => setTimeout(() => r({ state: "ok", detail: "" }), 200)), 20);
  assert.equal(slow.state, "fail");
  assert.match(slow.detail, /timed out/);
});

test("skills: ready, limited by an optional dependency, not set up, broken", () => {
  const c = (key: string, state: StatusCheck["state"]): StatusCheck => ({ key, group: "Skills", name: key, state, detail: "", usedBy: "" });
  const checks = [c("python", "ok"), c("yahoo-chart", "ok"), c("yahoo-backup", "warn"), c("trader-config", "off"), c("yahoo-rss", "fail"), c("sec", "off")];
  const h = Object.fromEntries(skillHealth(checks).map((x) => [x.skill, x]));
  assert.equal(h["trader-entry"].state, "ok");
  assert.equal(h["trader-entry"].summary, "Ready");
  assert.equal(h["trader-alerts"].state, "warn", "an optional backup only limits it");
  assert.match(h["trader-alerts"].summary, /limited: yahoo-backup/);
  assert.equal(h["trader-budget"].state, "off");
  assert.equal(h["trader-news"].state, "fail", "a required feed is down");
  assert.equal(h["trader-scanner"].state, "fail", "an unknown dependency (no check) counts as broken");
  // every skill folder in .claude/skills has an entry, and every dependency key is checked by lib/data/status.ts
  const src = readFileSync("lib/data/status.ts", "utf8");
  for (const s of SKILL_DEPS) for (const k of [...s.needs, ...(s.optional ?? [])]) assert.ok(src.includes(`key: "${k}"`), `no check for ${k}`);
  const folders = readdirSync(".claude/skills", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.deepEqual(folders.filter((f) => !SKILL_DEPS.some((s) => s.skill === f)), [], "a skill without a dependency entry");
});
