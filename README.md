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
| `lib/levels.ts`, `lib/timemachine.ts`, `lib/clock.ts`, `lib/news.ts`, `lib/earnings.ts`, `lib/checklist.ts` | Support/resistance, Time Machine, NYSE hours, news/8-K tagging, SEC earnings, the pre-trade checklist (pure) |
| `lib/data/sec.ts`, `app/api/research/route.ts` | SEC EDGAR filings and XBRL facts (server) |
| `lib/congress.ts`, `lib/data/congress.ts`, `components/CongressCard.tsx` | House PTR index + PDF parsing (ported from `/trader-pelosi`) and the dashboard card |
| `lib/data/ibkr.ts`, `app/api/ibkr/route.ts`, `components/IbkrSync.tsx` | Read-only IBKR Client Portal Gateway sync and the Refresh button |
| `scripts/sync-ibkr.ts` | Turns the IBKR connector's output into `trader/portfolio.json` |

## Ticker page: everything for one stock

Click any ticker to get the whole picture in one place, with each day-trader skill's work ported in:

| Panel | What | From |
|---|---|---|
| Header | Price, move, NYSE open/closed with holidays and early closes | `/trader-alerts` |
| Chart | Candles, 50/200-day averages, support and resistance (2+ touches), the plan's stop and target, past calls | Dodona |
| Agent call | BUY / SELL / HOLD from the Claude agent or the rule engine; the agent also gets the levels and the next earnings date | Dodona |
| **Checklist** | Every signal as ✓ / ! / ✗ with the reason: trend, market, relative strength, setup today and its track record, volume, room to the target, stop below support, Time Machine odds, risk check, earnings date, big move, headline risk, important 8-Ks | all |
| Setups | The five scanner setups on the last close with this stock's track record, plus today's opening-range breakout | `/trader-scanner`, `/trader-entry` |
| Chart analysis | Support / resistance levels (swing highs and lows grouped within half an ATR) and the technicals | Dodona |
| Trade plan | Stop, target, shares sized to your IBKR account, PASS/BLOCK | `/trader-exit`, `/trader-budget`, `/trader-risk` |
| Time Machine | 10,000 seeded replays of the plan over the next 20 sessions, rebuilt from this stock's last year of daily bars; same stop-first rule and verdict thresholds as the skill | `/trader-timemachine` |
| News & filings | Headlines tagged (earnings, analyst, legal, deal, risk…) and recent SEC filings with 8-K items in plain words | `/trader-news` |
| Earnings | Last 6 quarters from SEC XBRL facts: revenue, margins, net income, EPS, each vs a year earlier, plus TTM and what changed | `/trader-analyst` |

The checklist and Time Machine answer "what if I bought here?" even when the call isn't BUY. SEC panels need `SEC_USER_AGENT` in `.env.local` (SEC requires a name and email). Congress trades live on the dashboard (below). Not ported: `/trader-broker` (Dodona never places orders).

## Setups: swing + intraday

**/setups** scans your IBKR holdings, your watchlist and any tickers you add, using the same rules as the day-trader skills:

- **Swing** (daily bars): `/trader-scanner`'s five setups (20-day breakout, bull flag, reclaimed 20-day average, oversold, oversold bounce) on the last completed close, each with a trade plan sized to your account.
- **Intraday** (5-minute bars): the opening-range breakout (first close above the first 15 minutes' high), stop at the range midpoint, flat by the close.
- **Track record per stock**: every past time the setup fired (~3 years daily, ~60 sessions intraday), traded with the same stop and target, as average R, win rate and target/stop/timed-out counts. Swing setups are compared with the same plan entered on any day, which is what a setup has to beat. Samples under 10 trades are flagged.

- **Confirmation** (`lib/market.ts`): market (SPY above its 50-day average; intraday uses the previous close, so no look-ahead), relative strength (3-month return minus SPY's) and volume (swing: ≥1.5× the 20-day average; intraday: breakout bar ≥1.0× the opening-range bars, `/trader-entry`'s check). Each setup shows today's checks plus "when confirmed": the track record of only the past trades where each check passed, so you can see whether it helps on that stock.
- The swing rule engine scores the market trend and relative strength as factors too, and the Claude agent receives both.

A track record is the past, not a forecast. No commissions or slippage; a gap through a stop can fill worse than −1R.

## Congress trades (dashboard)

The dashboard's **Congress trades** card reads the House Clerk's public STOCK Act reports the way `/trader-pelosi` does: the yearly index, then each Periodic Transaction Report PDF (read with pdf.js, cached once per report in `trader/state/congress/`). It shows trades in your holdings and watchlist, the members you track (Pelosi by default, editable), and the tickers the most members bought in the last 30 days. Amounts are ranges, owners matter (SP = spouse), and every row links to its PDF with how many days it took to disclose (over 45 is flagged). Fast, not early: these trades are days to weeks old. House only; paper filings with no text layer are counted, not parsed.

## Portfolio (Interactive Brokers)

Two ways to load your positions, both read-only (Dodona never places orders):

**From Dodona: the "Refresh from IBKR" button** (Portfolio page, and on stale trade plans) reads IBKR's Client Portal Gateway, IBKR's own small Java app that serves its Web API on this machine:

1. Install Java (`brew install --cask temurin`), download the Client Portal Gateway from IBKR's Web API page and unzip it.
2. In `root/conf.yaml` set `listenPort: 5001` (macOS AirPlay Receiver already uses 5000).
3. Start it with `bin/run.sh root/conf.yaml`, open https://localhost:5001 and log in (once a day).
4. Press **Refresh from IBKR**, or in a Claude Code session say **"refresh IBKR"**: the `/ibkr-gateway` skill checks the gateway, starts it if needed, sends you to log in, then runs `npm run ibkr -- sync`. Dodona reads accounts, positions and the summary and writes `trader/portfolio.json`. Set `IBKR_GATEWAY_URL` / `IBKR_ACCOUNT` in `.env.local` to change the port or pick an account; only localhost URLs are accepted.

**Through Claude: the IBKR connector:**

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
- Market-wide scan (~5,900 symbols) on the Setups page, like `/trader-scanner daily`
- Earnings-calendar and ex-dividend alerts; SEC filings and reported quarters in the agent context
- Congress trades for one stock on its ticker page; Senate reports
- Orders through the IBKR gateway, each one shown as a ticket and placed only on your explicit yes
- Paper-trading ledger to grade the agents' and setups' live calls over time
