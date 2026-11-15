---
name: dodona-sync
description: >-
  Sync the user's Interactive Brokers positions into Dodona. Reads the IBKR
  connector (get_account_positions and get_account_summary, read-only),
  writes trader/portfolio.json, and Dodona's Portfolio page and trade plans
  pick it up. Use when the user says "sync my IBKR positions", "refresh my
  portfolio", "pull my positions", "update Dodona from Interactive Brokers",
  or before analyzing their holdings.
---

# Dodona IBKR sync

Read-only. Never call any order, alert, watchlist or other write tool on the
broker connector from this skill.

1. Call the Interactive Brokers connector's `get_account_positions` and
   `get_account_summary` (no arguments).
2. Save each result **verbatim** (the exact JSON the tool returned) with the
   Write tool:
   - `trader/ibkr/positions.json`
   - `trader/ibkr/summary.json`
3. From the repo root run:

   ```bash
   npm run sync:ibkr
   ```

   It writes `trader/portfolio.json` (gitignored) and prints the top holdings.
4. Tell the user how many positions synced, cash and net liquidation, and
   point them to `/portfolio` in Dodona (http://localhost:3000/portfolio).

The file is a superset of the day-trader skills' `trader/portfolio.json`
(`cash`, `positions[].ticker`, `shares`, `lots`), so `/trader-budget`,
`/trader-news` and `/trader-alerts` use the same holdings.

Account data is private: never paste it into commits, issues or external
services. `trader/` is gitignored; keep it that way.
