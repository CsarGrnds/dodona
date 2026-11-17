// Server-only: the Claude session that is running right now, so the Desk page can watch it live.
// Kept on globalThis because Next.js may load this module once per route in development.
import type { AgentSession } from "../desk";

const KEY = Symbol.for("dodona.desk.live");
type Holder = { session?: AgentSession; updatedAt?: number };
const holder = (): Holder => ((globalThis as Record<symbol, Holder>)[KEY] ??= {});

export function setLiveSession(s: AgentSession) {
  const h = holder();
  h.session = structuredClone(s);
  h.updatedAt = Date.now();
}

export function getLiveSession(): { session?: AgentSession; updatedAt?: number } {
  const h = holder();
  return { session: h.session, updatedAt: h.updatedAt };
}
