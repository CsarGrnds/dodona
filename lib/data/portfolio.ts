// Server-only: reads the synced IBKR portfolio from disk (trader/portfolio.json, gitignored).
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parsePortfolio, type Portfolio } from "../portfolio";

export const portfolioPath = () => resolve(process.cwd(), process.env.DODONA_PORTFOLIO ?? "trader/portfolio.json");

/** The synced portfolio, or null when nothing has been synced yet. */
export async function readPortfolio(): Promise<Portfolio | null> {
  let text: string;
  try {
    text = await readFile(portfolioPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const pf = parsePortfolio(JSON.parse(text));
  if (!pf) throw new Error("trader/portfolio.json is not a valid portfolio");
  return pf;
}
