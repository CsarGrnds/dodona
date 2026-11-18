// The trading settings, in one place: what each one means, its limits, and the checks across them.
// Pure and shared: the Settings page renders from FIELDS, the API validates with validateRules.
// The rules live in trader/config.json, the file every /trader-* skill and Dodona's desk read.

export type FieldType = "usd" | "pct" | "int" | "ratio" | "time" | "bool" | "tickers" | "text" | "choice";

export interface Field {
  key: string;
  label: string;
  help: string;
  type: FieldType;
  min?: number;
  max?: number;
  options?: Array<{ value: string; label: string }>;
}

export interface Section {
  id: string;
  title: string;
  blurb: string;
  fields: Field[];
}

export const RULE_SECTIONS: Section[] = [
  {
    id: "money",
    title: "Money",
    blurb: "How much is for trading and how much always stays in cash.",
    fields: [
      { key: "budget", label: "Budget", type: "usd", min: 1, help: "The money this is for. Only money you can afford to lose." },
      { key: "cash_buffer_pct", label: "Cash buffer", type: "pct", min: 0, max: 100, help: "Always kept in cash, never sized into a trade." },
      { key: "max_position_pct", label: "Biggest position", type: "pct", min: 1, max: 100, help: "No single stock may be more than this share of the budget." },
      { key: "max_order_usd", label: "Biggest order", type: "usd", min: 1, help: "The most one order may cost." },
      { key: "min_order_usd", label: "Smallest order", type: "usd", min: 0, help: "Orders below this are refused (fees would eat them)." },
    ],
  },
  {
    id: "risk",
    title: "Risk",
    blurb: "The losses each trade and each day may reach. The stop decides the size: the further the stop, the fewer shares.",
    fields: [
      { key: "max_loss_per_trade_usd", label: "Max loss per trade", type: "usd", min: 0.01, help: "What one trade may lose if the stop fills at the stop. Sizes every trade." },
      { key: "max_daily_loss_usd", label: "Max loss per day", type: "usd", min: 0.01, help: "Losses taken plus the risk still open. Once reached, no new entries today." },
      { key: "max_fee_pct", label: "Max fees vs risk", type: "pct", min: 5, max: 300, help: "IBKR commissions (in and out) may be at most this share of a trade's max loss; above it, real orders are refused. 25% is the safe default: at 100%+ a winning trade barely pays for its fees, and a losing one costs about double." },
      { key: "min_reward_risk", label: "Min reward : risk", type: "ratio", min: 0, max: 20, help: "The target must be at least this many times the risk (1.0 = 1R)." },
      { key: "require_stop", label: "Require a stop", type: "bool", help: "Every entry must carry a stop-loss. Strongly recommended." },
    ],
  },
  {
    id: "day",
    title: "Trading day",
    blurb: "When entries are allowed and when day trades must be closed, New York time.",
    fields: [
      { key: "max_trades_per_day", label: "Trades per day", type: "int", min: 0, max: 50, help: "New entries per day. 0 pauses new entries." },
      { key: "max_orders_per_day", label: "Orders per day", type: "int", min: 1, max: 200, help: "trader-risk's cap on all orders, exits included." },
      { key: "no_entries_before", label: "No entries before", type: "time", help: "Lets the opening range form first (it opens at 09:30)." },
      { key: "no_entries_after", label: "No entries after", type: "time", help: "Leaves time for a trade to work before the close." },
      { key: "flat_by", label: "Flat by", type: "time", help: "Day trades are closed by this time (the market closes at 16:00)." },
    ],
  },
  {
    id: "stocks",
    title: "Stocks",
    blurb: "What may be traded.",
    fields: [
      { key: "blocked", label: "Never trade", type: "tickers", help: "Tickers the desk, the team and trader-risk always refuse. Separate with commas." },
      { key: "fractional", label: "Fractional shares", type: "bool", help: "Only for weights mode; bracket orders always use whole shares." },
      { key: "sec_user_agent", label: "SEC contact", type: "text", help: "Name and email SEC EDGAR asks for (news 8-Ks, earnings analyst). Stays on this computer." },
    ],
  },
  {
    id: "broker",
    title: "Broker",
    blurb: "Where real orders would go. Dodona's desk and the trade team stay on paper either way.",
    fields: [
      { key: "broker", label: "Broker", type: "choice", options: [{ value: "ibkr", label: "Interactive Brokers" }, { value: "alpaca", label: "Alpaca" }], help: "Which broker /trader-broker and Dodona's order ticket work with." },
      { key: "ibkr_orders", label: "Send orders to IBKR", type: "bool", help: "Lets you place the order trader-risk passed from Dodona's Desk, through the IBKR gateway: only on your typed confirmation and click, and only to a paper account (DU…) while Paper trading is on." },
    ],
  },
];

/** Safety switches the page shows but never changes: they are yours to change in trader/config.json. */
export const LOCKED: Array<{ key: string; label: string; safe: unknown; help: string }> = [
  { key: "paper", label: "Paper trading", safe: true, help: "Orders to IBKR only go to a paper account (DU…). The trade team always runs on paper, whatever this says." },
  { key: "allow_margin", label: "Margin", safe: false, help: "Borrowed money." },
  { key: "allow_short", label: "Short selling", safe: false, help: "Selling stock you don't own." },
  { key: "allow_options", label: "Options", safe: false, help: "Contracts, not shares." },
];

export const FIELDS = RULE_SECTIONS.flatMap((s) => s.fields);

/** Models a trade subagent may run on (Claude Code's `model:` frontmatter). */
export const AGENT_MODELS = ["haiku", "sonnet", "opus", "inherit"] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];

export const TEAM: Array<{ agent: string; label: string; job: string; suggested: AgentModel }> = [
  { agent: "trade-scanner", label: "Scanner", job: "Runs the scan, lists candidates", suggested: "haiku" },
  { agent: "trade-news", label: "News", job: "Judges headlines and 8-Ks", suggested: "sonnet" },
  { agent: "trade-entry", label: "Entry", job: "Has the breakout triggered?", suggested: "haiku" },
  { agent: "trade-exit", label: "Exit plan", job: "Stop, target, R", suggested: "haiku" },
  { agent: "trade-timemachine", label: "Time Machine", job: "Odds from 10,000 replays", suggested: "haiku" },
  { agent: "trade-analyst", label: "Analyst", job: "Reads earnings trends", suggested: "sonnet" },
  { agent: "trade-budget", label: "Budget", job: "Sizes the order", suggested: "haiku" },
  { agent: "trade-risk", label: "Risk", job: "PASS or BLOCK", suggested: "haiku" },
  { agent: "trade-chartist", label: "Chartist", job: "Reads the charts as images", suggested: "sonnet" },
  { agent: "trade-coach", label: "Coach", job: "Daily review, writes the playbook", suggested: "opus" },
];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/**
 * Check edited rules. Returns the cleaned values, or an error per field. Unlike the desk's
 * normalizeDeskRules (which falls back to defaults so trading never breaks), nothing here is
 * silently replaced: a bad value is sent back to be fixed.
 */
export function validateRules(input: Record<string, unknown>): { ok: true; values: Record<string, unknown> } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  for (const f of FIELDS) {
    if (!(f.key in input)) continue;
    const v = input[f.key];
    if (f.type === "choice") {
      if (!f.options?.some((o) => o.value === v)) errors[f.key] = `one of ${f.options?.map((o) => o.label).join(", ")}`;
      else values[f.key] = v;
    } else if (f.type === "bool") {
      if (typeof v !== "boolean") errors[f.key] = "on or off";
      else values[f.key] = v;
    } else if (f.type === "time") {
      const t = String(v ?? "").trim().padStart(5, "0");
      if (!TIME.test(t)) errors[f.key] = "a time like 09:45";
      else values[f.key] = t;
    } else if (f.type === "tickers") {
      const list = (Array.isArray(v) ? v : String(v ?? "").split(/[\s,]+/)).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
      const bad = list.find((x) => !/^[A-Z][A-Z0-9.-]{0,9}$/.test(x));
      if (bad) errors[f.key] = `"${bad}" isn't a ticker`;
      else values[f.key] = [...new Set(list)];
    } else if (f.type === "text") {
      const s = String(v ?? "").trim();
      if (s.length > 200) errors[f.key] = "200 characters at most";
      else values[f.key] = s;
    } else {
      const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,%\s]/g, ""));
      if (String(v ?? "").trim() === "" || !Number.isFinite(n)) errors[f.key] = "a number";
      else if (f.type === "int" && !Number.isInteger(n)) errors[f.key] = "a whole number";
      else if (f.min !== undefined && n < f.min) errors[f.key] = `at least ${f.min}`;
      else if (f.max !== undefined && n > f.max) errors[f.key] = `at most ${f.max}`;
      else values[f.key] = f.type === "usd" ? Math.round(n * 100) / 100 : n;
    }
  }
  const num = (k: string) => (typeof values[k] === "number" ? (values[k] as number) : undefined);
  const t = (k: string) => (typeof values[k] === "string" && TIME.test(values[k] as string) ? minutes(values[k] as string) : undefined);
  const loss = num("max_loss_per_trade_usd"), day = num("max_daily_loss_usd"), budget = num("budget");
  if (loss !== undefined && day !== undefined && loss > day && !errors.max_daily_loss_usd) errors.max_daily_loss_usd = "must be at least the max loss per trade";
  if (loss !== undefined && budget !== undefined && loss > budget && !errors.max_loss_per_trade_usd) errors.max_loss_per_trade_usd = "can't be more than the budget";
  const lo = num("min_order_usd"), hi = num("max_order_usd");
  if (lo !== undefined && hi !== undefined && lo > hi && !errors.min_order_usd) errors.min_order_usd = "must be at most the biggest order";
  const before = t("no_entries_before"), after = t("no_entries_after"), flat = t("flat_by");
  if (before !== undefined && before < 570 && !errors.no_entries_before) errors.no_entries_before = "the market opens at 09:30";
  if (before !== undefined && after !== undefined && after <= before && !errors.no_entries_after) errors.no_entries_after = "must be after \"no entries before\"";
  if (after !== undefined && flat !== undefined && flat <= after && !errors.flat_by) errors.flat_by = "must be after \"no entries after\"";
  if (flat !== undefined && flat > 960 && !errors.flat_by) errors.flat_by = "the market closes at 16:00";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
}

/** What a set of rules means in plain words: the size of a typical trade. */
export function rulesSummary(r: Record<string, unknown>): string[] {
  const n = (k: string) => Number(r[k]);
  const out: string[] = [];
  if (n("budget") > 0) out.push(`$${(n("budget") * (1 - n("cash_buffer_pct") / 100)).toFixed(0)} of $${n("budget").toFixed(0)} can be traded; $${(n("budget") * n("cash_buffer_pct") / 100).toFixed(0)} stays in cash.`);
  if (n("max_loss_per_trade_usd") > 0 && n("max_daily_loss_usd") > 0)
    out.push(`A trade risks at most $${n("max_loss_per_trade_usd").toFixed(2)}; after $${n("max_daily_loss_usd").toFixed(2)} lost or at risk in a day, no new entries (${Math.floor(n("max_daily_loss_usd") / n("max_loss_per_trade_usd"))} full losses).`);
  if (r.no_entries_before && r.no_entries_after && r.flat_by) out.push(`Entries ${r.no_entries_before}–${r.no_entries_after} New York time, up to ${n("max_trades_per_day")} a day; day trades flat by ${r.flat_by}.`);
  return out;
}
