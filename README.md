# Dodona

Browser-based investment analytics with a **per-ticker agent** that follows each company and suggests **BUY / SELL / HOLD**, re-evaluating as new data arrives.

> Decision support, not financial advice. Market data comes from Yahoo Finance (unofficial) with a Google Finance fallback and may be delayed or wrong.

## How it works

```
Browser (watchlist, auto-follow loop, call history in localStorage)
   │  POST /api/analyze {symbol, strategy, previousCall}
   ▼
Next.js API route
   ├─ Data layer ── Yahoo Finance: quote, 1y+ daily bars, fundamentals, news
   │                └─ Google Finance page scrape (price-only fallback)
   ├─ Indicators ── SMA 20/50/200, EMA, RSI, MACD, Bollinger, ATR, returns, crosses
   ├─ Rule engine ─ explainable factors (−2..+2 each) → score −100..100 → BUY ≥ 25, SELL ≤ −25
   │                • dividend: yield vs 5y avg, payout, P/E, growth, leverage, 200d context, analyst target
   │                • swing: trend, golden/death cross, RSI, MACD, Bollinger, momentum, volume
   └─ Claude agent ─ reads all of the above + headlines + its previous call,
                     returns action, confidence, thesis, risks, and "what would change the call"
```

- **Following:** every ticker on the dashboard is re-analyzed on an interval (5/15/30/60 min) while the tab is open. When a call flips, the card is highlighted and (optionally) a browser notification fires.
- **Memory:** each ticker's agent gets its last call, so it says what changed instead of starting cold. History is plotted as markers on the chart.
- **No API key?** Dodona still works in rules-only mode.

## Run it

```bash
npm install
cp .env.example .env.local      # add ANTHROPIC_API_KEY for the Claude agent (optional)
npm run dev                     # http://localhost:3000
```

Offline / demo mode with synthetic data: `DODONA_MOCK=1 npm run dev`

Tests: `npm test` · Typecheck: `npm run typecheck`

## Layout

| Path | What |
|---|---|
| `lib/data/` | Yahoo provider, Google fallback, mock provider, cached snapshot |
| `lib/indicators.ts` | Technical indicators |
| `lib/signals.ts` | Dividend + swing rule engines |
| `lib/plan.ts` | Trade plan for BUY calls: ATR stop, R-multiple target, position size, PASS/BLOCK risk checks |
| `lib/agent.ts` | Claude agent prompt + JSON parsing |
| `lib/analyze.ts` | Orchestrates snapshot → indicators → rules → agent |
| `lib/store.ts` | Browser persistence (watchlist, history, settings) |
| `app/page.tsx` | Watchlist dashboard with auto-follow |
| `app/ticker/[symbol]/page.tsx` | Ticker agent page: chart, call, factors, fundamentals, news |

## Day-trader skills (Claude Code)

`.claude/skills/trader-*` vendors the 11 skills from [day-trader-skill](https://github.com/Jakeschincariol/day-trader-skill) (MIT, see `.claude/skills/LICENSE-day-trader-skill`). In a Claude Code session in this repo, run them as slash commands:

```
/trader-scanner → /trader-news → /trader-entry → /trader-exit → /trader-timemachine → /trader-budget → /trader-risk → /trader-broker
/trader-alerts · /trader-analyst · /trader-pelosi
```

- Standard-library Python 3.8+, nothing to install. `/trader-pelosi` uses `pdftotext` (poppler) if present.
- They read and write a `trader/` folder at the repo root (gitignored): `config.json`, `plan.json`, `orders.json`, the broker log.
- SEC tools need `"sec_user_agent": "Your Name you@example.com"` in `trader/config.json` or the `SEC_USER_AGENT` env var.
- Nothing places an order on its own; `/trader-broker` is paper by default and requires your explicit yes per order.
- The skills are independent of the Next.js app; Dodona's UI does not call them.

## Roadmap ideas

- Server-side scheduler (Cloud Run job / cron) so agents follow tickers even with the browser closed, plus a DB (Postgres/Firestore) for shared history
- Backtest the rule engine against history before trusting it
- Earnings-calendar and ex-dividend triggers; SEC filings in the agent context
- Portfolio view (positions, cost basis, concentration) from an IBKR export or the Client Portal API
- Paper-trading ledger to score each agent's calls over time
