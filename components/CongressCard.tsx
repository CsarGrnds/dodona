"use client";
// Dashboard card: Congress trades from the House Clerk's PTRs (ported from /trader-pelosi).
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Spinner } from "@/components/ui";
import { fetchPortfolio } from "@/lib/client";
import { amountLabel, flatten, isBuy, mostBought, type CongressResult, type TradeRow } from "@/lib/congress";
import { getCongressMembers, getWatchlist, setCongressMembers } from "@/lib/store";

const DAYS = 30;

type Grouped = TradeRow & { count: number };

/** A report can list the same trade more than once (e.g. two accounts): show it once, "×2". */
function group(rows: TradeRow[]): Grouped[] {
  const by = new Map<string, Grouped>();
  for (const r of rows) {
    const k = [r.docId, r.ticker ?? r.asset, r.type, r.date, r.amount, r.owner, r.option ? `${r.option.kind}${r.option.strike}${r.option.expires}` : ""].join("|");
    const e = by.get(k);
    if (e) e.count++;
    else by.set(k, { ...r, count: 1 });
  }
  return [...by.values()];
}

function TradeLine({ t, showMember }: { t: Grouped; showMember?: boolean }) {
  const buy = isBuy(t);
  return (
    <li>
      <span className="mono small muted">{t.date?.slice(5) ?? "—"}</span>{" "}
      <span className={buy ? "up" : t.type.startsWith("S") ? "down" : ""}>{buy ? "Buy" : t.typeName === "partial sale" ? "Sell (part)" : t.type.startsWith("S") ? "Sell" : t.typeName}</span>{" "}
      {t.ticker ? (
        <Link className="mono" href={`/ticker/${encodeURIComponent(t.ticker)}?strategy=swing`}>{t.ticker}</Link>
      ) : (
        <span className="small">{t.asset.slice(0, 32)}</span>
      )}{" "}
      {t.option && <span className="tag">{t.option.contracts} {t.option.kind}s ${t.option.strike} {t.option.expires?.slice(0, 7)}</span>}{t.option && " "}
      <span className="mono small">{amountLabel(t)}</span>
      {t.count > 1 && <span className="small"> ×{t.count}</span>}
      {showMember && <span className="small muted"> · {t.member.replace(/^Hon\.\s*/, "")}</span>}
      {t.owner && <span className="small muted"> · {t.ownerName}</span>}
      <span className={`small ${t.late ? "down" : "muted"}`}>
        {" "}·{" "}
        <a href={t.url} target="_blank" rel="noreferrer" title={`Report ${t.docId}, filed ${t.filed ?? "?"}`}>
          {t.daysToDisclose === undefined || t.daysToDisclose < 0 ? `filed ${t.filed?.slice(5) ?? "?"}` : `filed ${t.daysToDisclose}d later`}
        </a>
      </span>
    </li>
  );
}

export default function CongressCard() {
  const [members, setMembers] = useState<string[]>();
  const [data, setData] = useState<CongressResult>();
  const [error, setError] = useState<string>();
  const [mine, setMine] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setMembers(getCongressMembers());
    const w = getWatchlist().map((i) => i.symbol);
    setMine(new Set(w));
    fetchPortfolio()
      .then((pf) => setMine(new Set([...w, ...(pf?.positions.map((p) => p.ticker) ?? [])])))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!members) return;
    let live = true;
    setData(undefined);
    setError(undefined);
    const q = members.map((m) => `&member=${encodeURIComponent(m)}`).join("");
    fetch(`/api/congress?days=${DAYS}${q}`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
        if (live) setData(d as CongressResult);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [members]);

  const view = useMemo(() => {
    if (!data) return undefined;
    const recent = flatten(data.recent);
    const tracked = flatten(data.tracked).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    return {
      inMine: group(recent.filter((t) => t.ticker && mine.has(t.ticker)).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))),
      tracked: group(tracked),
      top: mostBought(recent),
      trades: recent.length,
      scanned: data.recent.filter((p) => p.scanned).length,
    };
  }, [data, mine]);

  const saveMembers = () => {
    const m = draft.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10);
    const next = m.length ? m : ["pelosi"];
    setCongressMembers(next);
    setMembers(next);
    setEditing(false);
  };

  return (
    <section className="panel congress" style={{ marginBottom: 14 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Congress trades · STOCK Act</h2>
        <span className="spacer" />
        {data && (
          <span className="muted small">
            {data.recentFilings} House reports in the last {DAYS} days · {view?.trades} trades
          </span>
        )}
      </div>
      {error && <p className="err">{error}</p>}
      {!data && !error && (
        <p className="muted small">
          <Spinner /> Reading the House Clerk&apos;s reports (first load downloads each PDF once)…
        </p>
      )}
      {data && view && (
        <div className="congress-cols">
          <div>
            <div className="check-group">In your stocks</div>
            {view.inMine.length ? (
              <ul className="plain news">{view.inMine.slice(0, 6).map((t, i) => <TradeLine key={`${t.docId}-${i}`} t={t} showMember />)}</ul>
            ) : (
              <p className="muted small">No member traded your holdings or watchlist in reports filed the last {DAYS} days.</p>
            )}
          </div>
          <div>
            <div className="check-group row">
              {editing ? (
                <>
                  <input className="congress-input" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveMembers()} placeholder="pelosi, Josh Gottheimer" autoFocus />
                  <button className="btn ghost small" onClick={saveMembers}>Save</button>
                </>
              ) : (
                <>
                  Tracking {members?.join(", ")}
                  <button className="btn ghost small" onClick={() => { setDraft(members?.join(", ") ?? ""); setEditing(true); }} title="Change who you track">edit</button>
                </>
              )}
            </div>
            {view.tracked.length ? (
              <ul className="plain news">{view.tracked.slice(0, 6).map((t, i) => <TradeLine key={`${t.docId}-${i}`} t={t} showMember={(members?.length ?? 0) > 1} />)}</ul>
            ) : (
              <p className="muted small">No reports this year for {members?.join(", ")}.</p>
            )}
          </div>
          <div>
            <div className="check-group">Most bought (last {DAYS} days)</div>
            {view.top.length ? (
              <ul className="plain news">
                {view.top.map((x) => (
                  <li key={x.ticker}>
                    <Link className="mono" href={`/ticker/${encodeURIComponent(x.ticker)}?strategy=swing`}>{x.ticker}</Link>{" "}
                    <span className="small">{x.members} member{x.members > 1 ? "s" : ""} bought</span>
                    <span className="small muted"> · {x.buys} buys, {x.sells} sells</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No purchases parsed.</p>
            )}
          </div>
        </div>
      )}
      {data && (
        <p className="muted small" style={{ marginBottom: 0 }}>
          Public House filings, read from each PDF. Fast, not early: trades are disclosed up to 45 days after they happen (later is flagged red). Amounts are ranges. SP = spouse.
          {view && view.scanned > 0 && ` ${view.scanned} paper filing${view.scanned > 1 ? "s" : ""} can only be read as PDF.`}
          {data.warnings.length > 0 && ` ${data.warnings.length} report${data.warnings.length > 1 ? "s" : ""} could not be read.`}
        </p>
      )}
    </section>
  );
}
