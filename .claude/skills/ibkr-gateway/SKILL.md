---
name: ibkr-gateway
description: >-
  Connect Dodona to Interactive Brokers through the local IBKR Client Portal
  Gateway and refresh positions (read-only). Checks whether the gateway is
  running and logged in, starts it in a Terminal tab when it is down, sends
  the user to https://localhost:5001 to log in themselves (never types their
  credentials), waits for the login, then syncs positions, cash and net
  liquidation into trader/portfolio.json for Dodona. Use when the user says
  "refresh IBKR", "refresh IBKR cred", "reconnect IBKR", "IBKR login",
  "log in to IBKR", "start the IBKR gateway", "connect to IBKR",
  "IBKR expired", "refresh my positions from IBKR", or when Dodona's
  Refresh from IBKR button says the gateway is down or not logged in.
---

# IBKR gateway: connect, log in, refresh

The gateway is IBKR's own Java app, installed at `~/clientportal.gw` (override
with `IBKR_GATEWAY_DIR`). It serves IBKR's Web API on **https://localhost:5001**
(`listenPort: 5001` in `root/conf.yaml`, because macOS AirPlay uses 5000; its
`ips.allow` is `127.0.0.1` only, keep it that way). A login lasts about a day.

## Rules

- **Read-only.** This skill, `npm run ibkr` and Dodona's Today page only read
  accounts, positions, the summary, open orders (to compare your stops) and
  account performance (the main screen's chart). Never call order, trade, alert or account-setting endpoints. The one
  exception is Dodona's IBKR order panel (`lib/data/ibkrOrders.ts`): its what-if preview places
  nothing, and only the user's typed confirmation and click there can place an order. An
  order needs the user's explicit yes for that exact order (see `AGENTS.md`).
- **A paper login isn't your portfolio.** Don't `sync` while the gateway is logged in to a paper
  account (DU…): it would overwrite `trader/portfolio.json` with the paper account's positions.
- **Credentials are the user's.** Never type, ask for, store or log the IBKR
  username, password or two-factor codes. The user logs in on the gateway's
  own page. Don't open the login page in a browser you control to sign in.
- **Account data is private.** Never print full account numbers (the script
  shows the last 3 digits) and never commit `trader/`.

## Steps

Run everything from the repo root.

1. **Check.**

   ```bash
   npm run -s ibkr -- status
   ```

   - `READY` (exit 0): go to step 4.
   - `LOGIN NEEDED` (exit 3): go to step 3.
   - `DOWN` (exit 2): go to step 2.

2. **Start the gateway** (only when DOWN). First `npm run -s ibkr -- where`.
   If it isn't installed, stop and point the user to the README's
   "Portfolio (Interactive Brokers)" section (Java + gateway download + port
   5001 + `127.0.0.1` only); don't download anything without their yes.

   If it is installed, start it in the user's **Terminal panel** (long-running,
   so not with Bash), in a tab titled `IBKR gateway`, with cwd = the repo root:

   ```bash
   cd ~/clientportal.gw && bin/run.sh root/conf.yaml
   ```

   Read the tab until it prints `Open https://localhost:5001 to login`
   (a few seconds; the `sun.misc.Unsafe` warnings are harmless). If it says the
   port is in use, an old gateway is still running: check `status` again.

3. **Ask the user to log in.** Tell them, in one short message:
   open **https://localhost:5001** in their own browser, accept the
   self-signed certificate warning (Advanced → Proceed), sign in, approve the
   IBKR Mobile prompt, and wait for **"Client login succeeds"**. Logging in on
   interactivebrokers.com does not count; it has to be the localhost page.
   Then end the turn and wait for them to say they're in.

   When they say so, run `status` again. If it still says `LOGIN NEEDED`,
   check the gateway log for a finished login:

   ```bash
   grep -E "sso/(Authenticator|Dispatcher)" ~/clientportal.gw/logs/gw.message.$(date +%F).log | tail -3
   ```

   No `POST /sso/Dispatcher` means the login didn't complete through the
   gateway: ask them to retry on the localhost page and wait for the success
   message (2FA not approved and a closed tab are the usual causes).

4. **Sync.**

   ```bash
   npm run -s ibkr -- sync
   ```

   It writes `trader/portfolio.json` (the same file the IBKR connector sync and
   the day-trader skills use) and prints positions, net liquidation, cash and
   the top holdings. Exit 3/2 means the session dropped: back to step 3/2.

5. **Report** in two or three lines: positions synced, net liquidation, cash,
   and that Dodona's Portfolio page (http://localhost:3000/portfolio) and
   trade plans now use it. Day P&L isn't in the gateway's positions, so it
   reads $0 after a gateway sync.

## Without the gateway

If the user would rather not run the gateway, `/dodona-sync` reads the same
positions through Claude's IBKR connector.

## Reference

- `npm run ibkr -- status | sync | where` → `scripts/ibkr-gateway.ts`
  (exit 0 ok, 2 down, 3 login needed, 1 other).
- Code: `lib/data/ibkr.ts` (gateway client, localhost only), `app/api/ibkr/route.ts`
  (Dodona's Refresh from IBKR button), `.env.local`: `IBKR_GATEWAY_URL`,
  `IBKR_ACCOUNT`, `IBKR_GATEWAY_DIR`.
