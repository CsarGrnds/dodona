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
| `app/ticker/[symbol]/page.tsx` | Ticker agent page: chart, call, factors, trade plan, fundamentals, news |
| `lib/portfolio.ts`, `app/portfolio/page.tsx` | IBKR portfolio model and Portfolio page (holdings, weights, P&L, calls per position) |
| `lib/setups.ts`, `lib/backtest.ts`, `app/setups/page.tsx` | Swing setups + opening-range breakout (ported from the trader skills) with per-stock track records |
| `scripts/sync-ibkr.ts` | Turns the IBKR connector's output into `trader/portfolio.json` |

## Setups: swing + intraday

**/setups** scans your IBKR holdings, your watchlist and any tickers you add, using the same rules as the day-trader skills:

- **Swing** (daily bars): `/trader-scanner`'s five setups (20-day breakout, bull flag, reclaimed 20-day average, oversold, oversold bounce) on the last completed close, each with a trade plan sized to your account.
- **Intraday** (5-minute bars): the opening-range breakout (first close above the first 15 minutes' high), stop at the range midpoint, flat by the close.
- **Track record per stock**: every past time the setup fired (~3 years daily, ~60 sessions intraday), traded with the same stop and target, as average R, win rate and target/stop/timed-out counts. Swing setups are compared with the same plan entered on any day, which is what a setup has to beat. Samples under 10 trades are flagged.

- **Confirmation** (`lib/market.ts`): market (SPY above its 50-day average; intraday uses the previous close, so no look-ahead), relative strength (3-month return minus SPY's) and volume (swing: ≥1.5× the 20-day average; intraday: breakout bar ≥1.0× the opening-range bars, `/trader-entry`'s check). Each setup shows today's checks plus "when confirmed": the track record of only the past trades where each check passed, so you can see whether it helps on that stock.
- The swing rule engine scores the market trend and relative strength as factors too, and the Claude agent receives both.

A track record is the past, not a forecast. No commissions or slippage; a gap through a stop can fill worse than −1R.

## Portfolio (Interactive Brokers)

Dodona reads your positions from the Interactive Brokers connector through Claude (read-only, it never places orders):

1. In a Claude Code session in this repo, say **"sync my IBKR positions"**. The `/dodona-sync` skill calls the connector's `get_account_positions` and `get_account_summary`, saves them under `trader/ibkr/`, and runs `npm run sync:ibkr`.
2. That writes `trader/portfolio.json` (gitignored, stays on this machine). It's a superset of the day-trader skills' format, so `/trader-budget`, `/trader-news` and `/trader-alerts` see the same holdings.
3. Open **/portfolio**: net liquidation, cash, P&L, a concentration warning above 20% of the account, and the dividend and swing rule-engine calls for every holding. Ticker pages show what you hold, and trade plans size to your real net liquidation and cash, counting what you already own toward the position cap.

Positions update only when you sync; the page flags a sync older than a day.

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
- Support and resistance levels; earnings-date awareness
- Market-wide scan (~5,900 symbols) on the Setups page, like `/trader-scanner daily`
- Earnings-calendar and ex-dividend triggers; SEC filings in the agent context
- Direct IBKR Client Portal API so positions refresh without asking Claude to sync
- Paper-trading ledger to grade the agents' and setups' live calls over time
