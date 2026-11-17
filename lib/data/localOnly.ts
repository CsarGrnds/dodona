// Server-only. Claude Code transcripts hold whole conversations, so the routes that serve them answer
// only requests made to this machine by name (localhost / 127.0.0.1 / ::1). `next dev` also listens on
// the local network; a phone or another computer on it gets a 403 instead of your sessions.
import { NextResponse } from "next/server";

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function localOnly(req: Request): NextResponse | undefined {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
  if (LOCAL.has(host) || host.endsWith(".localhost")) return undefined;
  return NextResponse.json({ error: "Claude Code sessions are only shown on this computer (open Dodona at http://localhost)." }, { status: 403 });
}

/**
 * For routes that change files: also refuse requests sent by another website open in your browser
 * (cross-site request forgery). They must come from a localhost page and be JSON, which a plain
 * cross-site form or fetch can't send without a preflight that Dodona never answers.
 */
export function localWrite(req: Request): NextResponse | undefined {
  const denied = localOnly(req);
  if (denied) return denied;
  const origin = req.headers.get("origin");
  let originHost = "";
  try {
    originHost = origin ? new URL(origin).hostname.toLowerCase() : "";
  } catch {
    /* malformed */
  }
  const okOrigin = !origin || LOCAL.has(originHost) || LOCAL.has(`[${originHost}]`) || originHost.endsWith(".localhost");
  const json = (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
  if (okOrigin && json) return undefined;
  return NextResponse.json({ ok: false, errors: { _: "Settings can only be changed from Dodona's own page on this computer." } }, { status: 403 });
}

/**
 * For the one route that can send a real order: on top of localWrite, the request must come from a
 * browser tab showing Dodona itself (browsers set Origin and Sec-Fetch-Site on every fetch; scripts
 * and command-line tools normally don't). Claude never calls it; see AGENTS.md.
 */
export function fromDodonaPage(req: Request): NextResponse | undefined {
  const denied = localWrite(req);
  if (denied) return denied;
  if (req.headers.get("origin") && req.headers.get("sec-fetch-site") === "same-origin") return undefined;
  return NextResponse.json({ ok: false, error: "Orders can only be placed by clicking in Dodona's own page." }, { status: 403 });
}
