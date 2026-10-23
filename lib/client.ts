"use client";
import { getHistory, recordAnalysis, type CallRecord } from "./store";
import type { Analysis, Strategy } from "./types";

/** Runs the agent for one ticker, passing its last call so it can reason about what changed. */
export async function runAnalysis(symbol: string, strategy: Strategy, useAgent: boolean): Promise<{ analysis: Analysis; previous?: CallRecord }> {
  const hist = getHistory(symbol).filter((h) => h.strategy === strategy);
  const prev = hist[hist.length - 1];
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbol,
      strategy,
      useAgent,
      previous: prev ? { action: prev.action, price: prev.price, generatedAt: prev.generatedAt, thesis: prev.thesis } : undefined,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Analyze failed (${res.status})`);
  const analysis = data as Analysis;
  const previous = recordAnalysis(analysis);
  return { analysis, previous };
}

export function notifyChange(symbol: string, from: string, to: string, price: number) {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(`Dodona: ${symbol} ${from} → ${to}`, { body: `New call at ${price.toFixed(2)}` });
    }
  } catch {
    /* ignore */
  }
}

export const fmt = {
  money: (v?: number, cur = "USD") =>
    v === undefined ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(v),
  pct: (v?: number, digits = 1) => (v === undefined ? "—" : `${(v * 100).toFixed(digits)}%`),
  signedPct: (v?: number) => (v === undefined ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`),
  num: (v?: number, digits = 2) => (v === undefined ? "—" : v.toFixed(digits)),
  big: (v?: number) => {
    if (v === undefined) return "—";
    const a = Math.abs(v);
    if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
    if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    return v.toFixed(0);
  },
  ago: (iso?: string) => {
    if (!iso) return "never";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  },
};
