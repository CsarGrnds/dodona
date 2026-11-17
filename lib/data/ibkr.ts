// Server only: Interactive Brokers Client Portal Gateway (read-only).
// The gateway is IBKR's own small Java app that runs on this machine; you log in to it in the
// browser once a day and it serves IBKR's Web API on localhost. This file only reads: accounts,
// positions, the account summary, orders. Nothing here places, changes or cancels orders: that is
// lib/data/ibkrOrders.ts alone, behind its gates (see there).
//
//   IBKR_GATEWAY_URL  default https://localhost:5001 (macOS AirPlay Receiver already uses 5000)
//   IBKR_ACCOUNT      optional account id; the first account otherwise

import { request } from "node:https";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fromIbkr, type Portfolio } from "../portfolio";
import { parseGatewayOrder, type OpenOrder } from "../prep";
import { cached } from "../cache";
import { parsePerformance, type PeriodKey, type Performance } from "../performance";
import { portfolioPath } from "./portfolio";

export const DEFAULT_GATEWAY = "https://localhost:5001";

export function gatewayUrl(): URL {
  const u = new URL(process.env.IBKR_GATEWAY_URL || DEFAULT_GATEWAY);
  // The gateway's certificate is self-signed, so TLS checks are relaxed below: only ever for this machine.
  if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) throw new Error("IBKR_GATEWAY_URL must point at this machine (localhost)");
  return u;
}

export class GatewayError extends Error {
  constructor(
    public code: "down" | "login" | "error",
    message: string,
  ) {
    super(message);
  }
}

/** Exported only for lib/data/ibkrOrders.ts. */
export function call<T>(method: "GET" | "POST" | "DELETE", path: string, timeoutMs = 10_000, body?: unknown): Promise<T> {
  const base = gatewayUrl();
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, base),
      { method, rejectUnauthorized: false, headers: { "User-Agent": "Dodona/0.1", Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) }, timeout: timeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode === 401 || res.statusCode === 403) return reject(new GatewayError("login", `Not logged in to the IBKR gateway (HTTP ${res.statusCode})`));
          if (!res.statusCode || res.statusCode >= 400) return reject(new GatewayError("error", `IBKR gateway HTTP ${res.statusCode} for ${path}`));
          try {
            resolve((body ? JSON.parse(body) : {}) as T);
          } catch {
            reject(new GatewayError("error", `IBKR gateway returned non-JSON for ${path}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new GatewayError("down", "IBKR gateway timed out")));
    req.on("error", (e) => reject(e instanceof GatewayError ? e : new GatewayError("down", `IBKR gateway not reachable at ${base.origin} (${(e as NodeJS.ErrnoException).code ?? e.message})`)));
    req.end(payload);
  });
}

export interface GatewayStatus {
  state: "down" | "login" | "ready";
  url: string;
  account?: string;
  message?: string;
}

export async function gatewayStatus(): Promise<GatewayStatus> {
  const url = gatewayUrl().origin;
  try {
    const st = await call<{ authenticated?: boolean; connected?: boolean }>("GET", "/v1/api/iserver/auth/status");
    if (!st.authenticated) return { state: "login", url, message: "Log in to the gateway in your browser" };
    return { state: "ready", url, account: await accountId().catch(() => undefined) };
  } catch (e) {
    const g = e instanceof GatewayError ? e : new GatewayError("error", String(e));
    return { state: g.code === "error" ? "down" : g.code, url, message: g.message };
  }
}

export async function accountId(): Promise<string> {
  const accts = await call<Array<{ id?: string; accountId?: string }>>("GET", "/v1/api/portfolio/accounts");
  const ids = (Array.isArray(accts) ? accts : []).map((a) => a.accountId ?? a.id).filter((x): x is string => !!x);
  const want = process.env.IBKR_ACCOUNT?.trim();
  if (want && !ids.includes(want)) throw new GatewayError("error", `IBKR_ACCOUNT ${want} is not one of this login's accounts`);
  if (!ids.length) throw new GatewayError("error", "The gateway returned no accounts");
  return want || ids[0];
}

/** Gateway positions + summary → the connector-shaped input fromIbkr already understands. */
export function gatewayToPortfolio(positions: Array<Record<string, unknown>>, summary: Record<string, unknown>, now = new Date()): Portfolio {
  const amt = (k: string) => {
    const v = summary[k] as { amount?: number; currency?: string } | undefined;
    return v && typeof v === "object" ? v.amount : undefined;
  };
  const cur = (summary.netliquidation as { currency?: string } | undefined)?.currency;
  return fromIbkr(
    {
      positions: positions.map((p) => ({
        contract_description: p.ticker ?? p.contractDesc,
        position: p.position,
        average_price: p.avgPrice ?? p.avgCost,
        market_price: p.mktPrice,
        market_value: p.mktValue,
        unrealized_pnl: p.unrealizedPnl,
        asset_class: p.assetClass,
        contract_id: p.conid,
      })),
    },
    {
      currency: cur ?? "USD",
      net_liquidation: amt("netliquidation"),
      total_cash_value: amt("totalcashvalue"),
      available_funds: amt("availablefunds"),
      gross_position_value: amt("grosspositionvalue"),
      buying_power: amt("buyingpower"),
    },
    now,
  );
}

/** Read positions and summary from the gateway and write trader/portfolio.json. */
export async function syncFromGateway(): Promise<Portfolio> {
  const acct = await accountId();
  const a = encodeURIComponent(acct);
  await call("POST", `/v1/api/portfolio/${a}/positions/invalidate`).catch(() => undefined); // fresh, not the gateway's cache
  const positions: Array<Record<string, unknown>> = [];
  for (let page = 0; page < 20; page++) {
    const rows = await call<Array<Record<string, unknown>>>("GET", `/v1/api/portfolio/${a}/positions/${page}`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    positions.push(...rows);
    if (rows.length < 100) break;
  }
  const summary = await call<Record<string, unknown>>("GET", `/v1/api/portfolio/${a}/summary`);
  const pf = gatewayToPortfolio(positions, summary);
  const file = portfolioPath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(pf, null, 2) + "\n");
  return pf;
}

/**
 * Live orders (read-only): the stops and limits resting at IBKR. The gateway fills its order
 * cache lazily, so the first call after a login can come back empty: ask once with force=true,
 * wait briefly, then read again.
 */
export async function openOrders(): Promise<OpenOrder[]> {
  await call("GET", "/v1/api/iserver/accounts").catch(() => undefined); // required before /iserver calls
  const read = (q = "") => call<{ orders?: Array<Record<string, unknown>> }>("GET", `/v1/api/iserver/account/orders${q}`);
  let res = await read("?force=true");
  if (!res.orders?.length) {
    await new Promise((r) => setTimeout(r, 1200));
    res = await read();
  }
  const want = process.env.IBKR_ACCOUNT?.trim();
  return (res.orders ?? [])
    .filter((o) => !want || !o.acct || o.acct === want)
    .map(parseGatewayOrder)
    .filter((o): o is OpenOrder => o !== null);
}

/**
 * Daily NAV and time-weighted return for a period, from IBKR's Portfolio Analyst (read-only; the
 * POST is a query). IBKR updates it once a day, so it is cached for 10 minutes.
 */
export async function accountPerformance(period: PeriodKey): Promise<Performance> {
  const acct = await accountId();
  return cached(`ibkr-perf:${acct}:${period}`, 10 * 60_000, async () => parsePerformance(await call("POST", "/v1/api/pa/performance", 20_000, { acctIds: [acct], period }), period));
}

/** The brokerage session's state (read-only): authenticated, connected, or competing with another login. */
export async function gatewayAuth(): Promise<{ authenticated: boolean; connected: boolean; competing: boolean; serverName?: string }> {
  const st = await call<{ authenticated?: boolean; connected?: boolean; competing?: boolean; serverInfo?: { serverName?: string } }>("GET", "/v1/api/iserver/auth/status");
  return { authenticated: !!st.authenticated, connected: !!st.connected, competing: !!st.competing, serverName: st.serverInfo?.serverName };
}
