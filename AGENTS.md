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
- Before finishing a change: `npm test`, `npm run typecheck`, and `DODONA_MOCK=1 npm run dev` for a visual check.
