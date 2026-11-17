# Dodona — agent instructions

Next.js 15 (App Router) + TypeScript. No CSS framework: styles live in `app/globals.css`.

- Server-only code: `lib/data/*`, `lib/agent.ts`, `lib/analyze.ts`, `app/api/*`. Never import these from client components.
- Client-only code: `lib/store.ts`, `lib/client.ts`, `components/*`, pages (all `"use client"`).
- `lib/indicators.ts`, `lib/signals.ts`, `lib/types.ts` are pure and shared.
- Rule factors must stay explainable: each one scores −2..+2 with a human-readable `detail`.
- The Claude agent must only reason from data passed to it; keep the "no invented numbers" rule in its system prompt.
- Yahoo returns some fields as percentages (fiveYearAvgDividendYield, debtToEquity); normalize to fractions in `lib/data/yahoo.ts`.
- Commit messages must start with `Claudia - ` (e.g. `Claudia - Add earnings-calendar trigger`).
- Secrets (API keys, GitHub tokens) live only in `.env` / `.env.local`, which are gitignored. Never hardcode or commit them; document new ones in `.env.example` with an empty value.
- The repo is public. README screenshots come only from the demo portfolio (`npm run demo:portfolio`, the `dodona-demo` launch config, `npm run screenshots`), never from a real account, a logged-in IBKR gateway or this machine's time zone.
- Keep `README.md` current in the same change: new pages, panels, API routes, scripts, skills, env vars and layout rows, and remove roadmap items that shipped.
- Before finishing a change: `npm test`, `npm run typecheck`, and `npm run dev` for a visual check with real market data (not mock mode).
- `.claude/skills/trader-*` are vendored day-trader skills (Python, stdlib only). They are not part of the Next.js app; don't import or call them from app code. Their working folder `trader/` is gitignored. Never place a broker order without the user's explicit yes for that exact order.
- The paper trade team (`/trade-desk` skill + `.claude/agents/trade-*.md` subagents) runs the trader skills in Claude Code, never from app code. They run with cwd `trader/paper/` (Dodona keeps it in step with the paper desk), never from the repo root, whose `trader/portfolio.json` is the real IBKR account. The team books only through `npm run desk -- book`, which requires trader-risk's PASS for that exact order; it never calls a broker or `/trader-broker`. Dodona only reads Claude Code transcripts (`lib/data/transcripts.ts`) to show the team's work, locally.
- `lib/data/ibkrOrders.ts` is the only code that can send an order (to IBKR, through the local gateway). Keep every gate: off unless `ibkr_orders` and `"broker": "ibkr"` are set, paper accounts (DU…) only while `"paper"` is true, trader-risk's PASS for that exact order in the last 15 minutes, never the same order twice, and the user's typed confirmation and click in Dodona. IBKR's questions are never auto-confirmed. Batches also refuse stocks the user already holds and trades whose IBKR fees exceed 25% of their risk. Claude never calls `POST /api/ibkr/orders` with `place`, `answer` or `cancel`, never turns `paper` off, and nothing scheduled (desk auto-run, `/loop`, the trade team) ever places a broker order. `/trade-desk live` only stages the morning batch (`npm run desk -- stage`); the user approves it in Dodona.
