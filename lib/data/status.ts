// Server only: live health checks for every connector Dodona uses (caches bypassed).
// Read-only: nothing here places orders, writes files, or sends account data anywhere.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentEnabled, agentModel } from "../agent";
import { CALENDAR_YEARS } from "../clock";
import { INDEX_URL } from "../congress";
import { syncAgeHours } from "../portfolio";
import { timed, type StatusCheck } from "../status";
import { googleQuote } from "./google";
import { accountPerformance, gatewayAuth, gatewayStatus, openOrders } from "./ibkr";
import { readPortfolio } from "./portfolio";
import { secUserAgent } from "./sec";
import { yahooBars, yahooFundamentals, yahooIntraday, yahooNews, yahooQuote } from "./yahoo";

const PROBE = "SPY";
// The day-trader skills' own User-Agent, so the checks see what the skills see.
const SKILL_UA = "Mozilla/5.0 (compatible; day-trader-skill/2.0; +https://github.com/Jakeschincariol/day-trader-skill)";
const run = (cmd: string, args: string[]) =>
  new Promise<string>((res, rej) => execFile(cmd, args, { timeout: 5000 }, (e, out, err) => (e ? rej(e) : res(`${out}${err}`.trim()))));
const head = (url: string) => fetch(url, { method: "GET", headers: { "User-Agent": SKILL_UA, Accept: "*/*" }, cache: "no-store" });
const mask = (id?: string) => (id ? `…${id.slice(-3)}` : "?");
const ago = (h: number) => (h < 1 ? `${Math.round(h * 60)} min ago` : h < 48 ? `${h.toFixed(1)} h ago` : `${Math.round(h / 24)} days ago`);

export async function runChecks(): Promise<StatusCheck[]> {
  const gw = await gatewayStatus();
  const gwReady = gw.state === "ready";
  const gwFix = gw.state === "down" ? "Say “refresh IBKR” in Claude Code: /ibkr-gateway starts the gateway and walks you through the login." : `Log in at ${gw.url} (accept the certificate warning, approve IBKR Mobile).`;
  const needGw = async () => ({ state: "off" as const, detail: `Needs the gateway (${gw.state === "down" ? "not running" : "not logged in"})`, fix: gwFix });

  const checks = await Promise.all([
    // ---- Broker
    timed({ key: "ibkr-gateway", group: "Broker", name: "IBKR Client Portal Gateway", usedBy: "Sync positions, Today, account chart" }, async () =>
      gw.state === "ready"
        ? { state: "ok", detail: `Logged in at ${gw.url}, account ${mask(gw.account)}` }
        : gw.state === "login"
          ? { state: "warn", detail: `Running at ${gw.url} but not logged in`, fix: gwFix }
          : { state: "fail", detail: gw.message ?? `Not reachable at ${gw.url}`, fix: gwFix },
    ),
    timed({ key: "ibkr-session", group: "Broker", name: "IBKR trading session", usedBy: "Reading orders (Dodona never places them)" }, async () => {
      if (!gwReady) return needGw();
      const a = await gatewayAuth();
      if (a.competing) return { state: "warn", detail: "Competing session: another IBKR login (TWS, Mobile or the web portal) holds the brokerage session", fix: "Log out of the other session, or log in to the gateway again." };
      if (!a.connected) return { state: "warn", detail: "Authenticated but not connected to IBKR's servers", fix: gwFix };
      return { state: "ok", detail: `Authenticated and connected${a.serverName ? ` (${a.serverName})` : ""}` };
    }),
    timed({ key: "ibkr-orders", group: "Broker", name: "IBKR open orders", usedBy: "Today: your stops and buy limits" }, async () => {
      if (!gwReady) return needGw();
      const o = await openOrders();
      const stops = o.filter((x) => x.stop !== undefined).length;
      return { state: "ok", detail: `${o.length} open order${o.length === 1 ? "" : "s"} read (${stops} stop${stops === 1 ? "" : "s"})` };
    }),
    timed({ key: "ibkr-performance", group: "Broker", name: "IBKR Portfolio Analyst", usedBy: "Main screen account chart" }, async () => {
      if (!gwReady) return needGw();
      const p = await accountPerformance("7D");
      return { state: "ok", detail: `${p.points.length} daily values, latest ${p.points.at(-1)?.date}` };
    }),
    timed({ key: "portfolio-file", group: "Local", name: "Synced portfolio (trader/portfolio.json)", usedBy: "Portfolio, Today, main screen, trade plans" }, async () => {
      const pf = await readPortfolio();
      if (!pf) return { state: "fail", detail: "Nothing synced yet", fix: "Press Sync from IBKR on the Portfolio page, or say “refresh IBKR”." };
      const h = syncAgeHours(pf);
      return h > 24
        ? { state: "warn", detail: `${pf.positions.length} positions, synced ${ago(h)}`, fix: "Refresh: the Sync button or “refresh IBKR”." }
        : { state: "ok", detail: `${pf.positions.length} positions, synced ${ago(h)}` };
    }),

    // ---- Market data (Yahoo, Google fallback)
    timed({ key: "yahoo-quote", group: "Market data", name: "Yahoo Finance: quotes", usedBy: "Every price in Dodona" }, async () => {
      const q = await yahooQuote(PROBE);
      const ageH = (Date.now() - new Date(q.asOf).getTime()) / 3_600_000;
      return { state: "ok", detail: `${PROBE} ${q.price.toFixed(2)} (${q.marketState ?? "?"}, quote ${ago(ageH)})` };
    }),
    timed({ key: "yahoo-daily", group: "Market data", name: "Yahoo Finance: daily bars", usedBy: "Charts, indicators, levels, setups, stops" }, async () => {
      const b = await yahooBars(PROBE, 30);
      if (!b.length) return { state: "fail", detail: "No bars returned" };
      return { state: "ok", detail: `${b.length} bars, last ${b.at(-1)!.time}` };
    }),
    timed({ key: "yahoo-intraday", group: "Market data", name: "Yahoo Finance: 5-minute bars", usedBy: "Opening-range breakouts (Setups)" }, async () => {
      const b = await yahooIntraday(PROBE, 5);
      if (!b.length) return { state: "warn", detail: "No 5-minute bars returned" };
      return { state: "ok", detail: `${b.length} bars, last ${new Date(b.at(-1)!.t).toISOString().slice(0, 16).replace("T", " ")} UTC` };
    }),
    timed({ key: "yahoo-fundamentals", group: "Market data", name: "Yahoo Finance: fundamentals", usedBy: "Dividend strategy, earnings dates, sectors" }, async () => {
      const f = await yahooFundamentals("AAPL");
      const n = Object.values(f).filter((v) => v !== undefined).length;
      return n >= 5 ? { state: "ok", detail: `${n} fields for AAPL${f.nextEarningsDate ? `, next earnings ${f.nextEarningsDate}` : ""}` } : { state: "warn", detail: `Only ${n} fields for AAPL` };
    }),
    timed({ key: "yahoo-news", group: "Market data", name: "Yahoo Finance: news", usedBy: "Ticker news, the agent, “why” on the main screen" }, async () => {
      const n = await yahooNews("AAPL", 3);
      return n.length ? { state: "ok", detail: `${n.length} headlines for AAPL` } : { state: "warn", detail: "No headlines returned" };
    }),
    timed({ key: "google", group: "Market data", name: "Google Finance (price fallback)", usedBy: "Prices when Yahoo's quote fails" }, async () => {
      const q = await googleQuote(PROBE);
      return q ? { state: "ok", detail: `${PROBE} ${q.price.toFixed(2)}` } : { state: "warn", detail: "Page read but no price found (the fallback may be broken)" };
    }),

    // ---- Research
    timed({ key: "sec", group: "Research", name: "SEC EDGAR", usedBy: "Ticker page filings and earnings · /trader-analyst · /trader-news (8-Ks)" }, async () => {
      const ua = await secUserAgent();
      if (!ua) return { state: "off", detail: "No SEC_USER_AGENT set: SEC panels are off", fix: "Add SEC_USER_AGENT=\"Your Name you@example.com\" to .env.local (Dodona) and \"sec_user_agent\" to trader/config.json (skills). The SEC requires a contact." };
      const res = await fetch("https://data.sec.gov/submissions/CIK0000320193.json", { headers: { "User-Agent": ua, Accept: "application/json" }, cache: "no-store" });
      return res.ok ? { state: "ok", detail: "Filings index reachable (AAPL)" } : { state: "fail", detail: `HTTP ${res.status}`, fix: res.status === 403 ? "SEC refused the User-Agent: use a real name and email." : undefined };
    }),
    timed({ key: "house", group: "Research", name: "House Clerk (Congress trades)", usedBy: "Congress trades card · /trader-pelosi" }, async () => {
      const year = new Date().getUTCFullYear();
      const res = await fetch(INDEX_URL(year), { method: "HEAD", headers: { "User-Agent": "Dodona/0.1" }, cache: "no-store" });
      if (!res.ok) return { state: "fail", detail: `${year} index: HTTP ${res.status}` };
      const mod = res.headers.get("last-modified");
      return { state: "ok", detail: `${year} disclosure index reachable${mod ? `, updated ${new Date(mod).toISOString().slice(0, 10)}` : ""}` };
    }),

    // ---- AI
    timed({ key: "claude", group: "AI", name: "Claude agent (Anthropic API)", usedBy: "BUY/SELL/HOLD agent on the watchlist and ticker pages" }, async () => {
      if (!agentEnabled()) return { state: "off", detail: "No ANTHROPIC_API_KEY: rules-only mode", fix: "Add ANTHROPIC_API_KEY to .env.local." };
      // Listing models validates the key and costs nothing.
      const res = await fetch("https://api.anthropic.com/v1/models?limit=100", { headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" }, cache: "no-store" });
      if (res.status === 401 || res.status === 403) return { state: "fail", detail: `API key rejected (HTTP ${res.status})`, fix: "Check ANTHROPIC_API_KEY in .env.local." };
      if (!res.ok) return { state: "warn", detail: `Anthropic API HTTP ${res.status}` };
      const ids: string[] = ((await res.json()).data ?? []).map((m: { id: string }) => m.id);
      const model = agentModel();
      return ids.includes(model) ? { state: "ok", detail: `Key valid, model ${model} available` } : { state: "warn", detail: `Key valid, but model ${model} isn't in the list`, fix: "Set ANTHROPIC_MODEL to an available model." };
    }),

    // ---- Local
    timed({ key: "calendar", group: "Local", name: "NYSE holiday calendar", usedBy: "Market clock, earnings countdowns" }, async () => {
      const y = new Date().getUTCFullYear();
      return CALENDAR_YEARS.includes(y + 1)
        ? { state: "ok", detail: `Covers ${CALENDAR_YEARS.join("–")}` }
        : CALENDAR_YEARS.includes(y)
          ? { state: "warn", detail: `Covers ${CALENDAR_YEARS.join("–")}: add ${y + 1} before the year ends`, fix: "Add next year's holidays to lib/clock.ts." }
          : { state: "fail", detail: `Covers ${CALENDAR_YEARS.join("–")}, not ${y}`, fix: "Add this year's holidays to lib/clock.ts." };
    }),
    // ---- Claude Code skills (/trader-*, /dodona-sync)
    timed({ key: "python", group: "Skills", name: "Python 3", usedBy: "Every /trader-* skill" }, async () => {
      const v = await run("python3", ["--version"]);
      const m = /Python (\d+)\.(\d+)/.exec(v);
      if (!m) return { state: "fail", detail: `Unexpected: ${v}` };
      return Number(m[1]) === 3 && Number(m[2]) >= 8 ? { state: "ok", detail: v } : { state: "fail", detail: `${v}: the skills need 3.8+`, fix: "brew install python" };
    }),
    timed({ key: "yahoo-chart", group: "Skills", name: "Yahoo chart API (direct)", usedBy: "/trader-scanner, entry, exit, timemachine, alerts, news" }, async () => {
      const r = await head(`https://query2.finance.yahoo.com/v8/finance/chart/${PROBE}?range=1d&interval=5m`);
      if (!r.ok) return { state: "fail", detail: `HTTP ${r.status}`, fix: r.status === 429 ? "Yahoo is rate-limiting: wait a few minutes." : undefined };
      const n = (await r.json())?.chart?.result?.[0]?.timestamp?.length ?? 0;
      return n ? { state: "ok", detail: `${n} 5-minute bars for ${PROBE}` } : { state: "warn", detail: "Reachable, but no bars returned" };
    }),
    timed({ key: "yahoo-rss", group: "Skills", name: "Yahoo headline feed (RSS)", usedBy: "/trader-news" }, async () => {
      const r = await head("https://feeds.finance.yahoo.com/rss/2.0/headline?s=AAPL&region=US&lang=en-US");
      if (!r.ok) return { state: "fail", detail: `HTTP ${r.status}` };
      const n = ((await r.text()).match(/<item>/g) ?? []).length;
      return n ? { state: "ok", detail: `${n} headlines for AAPL` } : { state: "warn", detail: "Feed reachable but empty" };
    }),
    timed({ key: "nasdaq", group: "Skills", name: "Nasdaq Trader symbol directory", usedBy: "/trader-scanner (the list of ~5,900 US stocks)" }, async () => {
      const r = await head("https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt");
      if (!r.ok) return { state: "fail", detail: `HTTP ${r.status}` };
      const lines = (await r.text()).split("\n").length;
      return lines > 1000 ? { state: "ok", detail: `nasdaqlisted.txt: ${lines.toLocaleString()} lines` } : { state: "warn", detail: `Only ${lines} lines` };
    }),
    timed({ key: "yahoo-backup", group: "Skills", name: "Yahoo chart API (backup host)", usedBy: "/trader-alerts and the scanner fall back to query1 when query2 fails" }, async () => {
      const r = await head(`https://query1.finance.yahoo.com/v8/finance/chart/${PROBE}?range=1d&interval=1d`);
      return r.ok ? { state: "ok", detail: "query1.finance.yahoo.com answers" } : { state: "warn", detail: `HTTP ${r.status}: no backup if query2 fails`, fix: r.status === 429 ? "Yahoo is rate-limiting: wait a few minutes." : undefined };
    }),
    timed({ key: "pdftotext", group: "Skills", name: "pdftotext (poppler)", usedBy: "/trader-pelosi: turning House PDFs into rows" }, async () => {
      try {
        const v = await run("pdftotext", ["-v"]);
        return { state: "ok", detail: v.split("\n")[0] };
      } catch {
        return { state: "warn", detail: "Not installed: /trader-pelosi finds new filings but can't read the PDFs (Dodona's Congress card reads them itself)", fix: "brew install poppler" };
      }
    }),
    timed({ key: "trader-config", group: "Skills", name: "Trading rules (trader/config.json)", usedBy: "/trader-budget, /trader-risk, flat-by and entry times" }, async () => {
      let cfg: Record<string, unknown>;
      try {
        cfg = JSON.parse(await readFile(join(process.cwd(), "trader", "config.json"), "utf8"));
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ENOENT"
          ? { state: "off", detail: "No config yet: /trader-budget has no budget and /trader-risk uses defaults", fix: "In Claude Code say “set my rules” (budget, max loss per trade, daily loss limit)." }
          : { state: "fail", detail: "config.json isn't valid JSON", fix: "Fix or delete trader/config.json, then “set my rules”." };
      }
      const keys = Object.keys(cfg);
      const budget = typeof cfg.budget === "number" ? `budget $${cfg.budget.toLocaleString()}` : "no budget";
      return { state: typeof cfg.budget === "number" ? "ok" : "warn", detail: `${keys.length} settings, ${budget}${cfg.sec_user_agent ? ", SEC contact set" : ""}`, fix: typeof cfg.budget === "number" ? undefined : "Say “set my rules” to add a budget." };
    }),
    timed({ key: "broker-mcp", group: "Skills", name: "Order broker (Alpaca MCP)", usedBy: "/trader-broker: sending approved orders" }, async () => {
      // Only server names and the paper flag are read; API keys are never read out or shown.
      const file = join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
      let servers: Record<string, { env?: Record<string, string> }> = {};
      try {
        servers = JSON.parse(await readFile(file, "utf8"))?.mcpServers ?? {};
      } catch {
        /* no desktop config */
      }
      const name = Object.keys(servers).find((k) => /alpaca/i.test(k));
      if (!name) return { state: "off", detail: "No Alpaca server in Claude Desktop: /trader-broker can build tickets but not send them", fix: "In Claude Code say “connect Alpaca” (paper trading keys, set up in Claude Desktop's config)." };
      const paper = String(servers[name].env?.ALPACA_PAPER_TRADE ?? "true").toLowerCase() !== "false";
      return { state: paper ? "ok" : "warn", detail: `“${name}” configured, ${paper ? "paper trading" : "LIVE trading"}`, fix: paper ? undefined : "Live trading is on: every order still needs your explicit yes." };
    }),
    timed({ key: "ibkr-connector", group: "Skills", name: "IBKR connector (Claude)", usedBy: "/dodona-sync" }, async () => {
      // The connector runs inside Claude, not here: its last saved output shows when it last worked.
      try {
        const st = await stat(join(process.cwd(), "trader", "ibkr", "positions.json"));
        const h = (Date.now() - st.mtimeMs) / 3_600_000;
        return { state: h > 24 * 7 ? "warn" : "ok", detail: `Last /dodona-sync ${ago(h)}` };
      } catch {
        return { state: "off", detail: "Never used here (the gateway is the main route)", fix: "Optional: say “sync my IBKR positions” in Claude Code." };
      }
    }),
  ]);
  return checks;
}
