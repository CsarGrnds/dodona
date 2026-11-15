"use client";
// Browser-side persistence: watchlist, per-ticker call history, settings.
// localStorage keeps v1 simple and private to this browser. Swap for a DB later.
import { normalizePlanSettings, type PlanSettings } from "./plan";
import type { Action, Analysis, Strategy } from "./types";

export interface WatchItem {
  symbol: string;
  strategy: Strategy;
  addedAt: string;
}

export interface CallRecord {
  generatedAt: string;
  action: Action;
  confidence: number;
  price: number;
  source: "agent" | "rules";
  strategy: Strategy;
  score: number;
  thesis?: string;
}

export interface Settings {
  autoFollow: boolean;
  intervalMin: number;
  useAgent: boolean;
  notify: boolean;
}

const K = {
  watch: "dodona.watchlist.v1",
  hist: (s: string) => `dodona.history.v1.${s}`,
  last: (s: string) => `dodona.last.v1.${s}`,
  settings: "dodona.settings.v1",
  plan: "dodona.plan.v1",
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — non-fatal */
  }
}

export const DEFAULT_WATCHLIST: WatchItem[] = [
  { symbol: "IBM", strategy: "dividend", addedAt: new Date(0).toISOString() },
  { symbol: "V", strategy: "dividend", addedAt: new Date(0).toISOString() },
  { symbol: "NVDA", strategy: "swing", addedAt: new Date(0).toISOString() },
];

export const getWatchlist = () => read<WatchItem[]>(K.watch, DEFAULT_WATCHLIST);
export const setWatchlist = (w: WatchItem[]) => write(K.watch, w);

export const getHistory = (symbol: string) => read<CallRecord[]>(K.hist(symbol), []);
export const getLastAnalysis = (symbol: string) => read<Analysis | null>(K.last(symbol), null);

/** Saves the analysis and appends to history. Returns the previous record (for change detection). */
export function recordAnalysis(a: Analysis): CallRecord | undefined {
  const hist = getHistory(a.symbol);
  const prev = hist[hist.length - 1];
  // Same analysis delivered twice (e.g. React dev double-invoking an effect): don't log it again.
  if (hist.some((h) => h.generatedAt === a.generatedAt && h.strategy === a.strategy)) return prev;
  const rec: CallRecord = {
    generatedAt: a.generatedAt,
    action: a.final.action,
    confidence: a.final.confidence,
    price: a.quote.price,
    source: a.final.source,
    strategy: a.strategy,
    score: a.rules.score,
    thesis: a.agent?.thesis,
  };
  write(K.hist(a.symbol), [...hist, rec].slice(-200));
  // Bars are large; the detail page refetches them, so store a lean copy.
  write(K.last(a.symbol), { ...a, bars: [] });
  return prev;
}

export const DEFAULT_SETTINGS: Settings = { autoFollow: true, intervalMin: 15, useAgent: true, notify: false };
export const getSettings = () => ({ ...DEFAULT_SETTINGS, ...read<Partial<Settings>>(K.settings, {}) });
export const setSettings = (s: Settings) => write(K.settings, s);

export const getPlanSettings = () => normalizePlanSettings(read<Partial<PlanSettings> | null>(K.plan, null));
export const setPlanSettings = (s: PlanSettings) => write(K.plan, s);

/** Extra tickers to scan on the Setups page (beyond holdings and the watchlist). */
export const getSetupExtras = () => read<string[]>("dodona.setups.extra.v1", []);
export const setSetupExtras = (s: string[]) => write("dodona.setups.extra.v1", s);
