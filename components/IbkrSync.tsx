"use client";
// "Refresh from IBKR": reads positions through the local IBKR Client Portal Gateway (read-only).
import { useState } from "react";
import { Spinner } from "@/components/ui";
import { fetchPortfolio } from "@/lib/client";
import type { Portfolio } from "@/lib/portfolio";

type Result = { state: "down" | "login" | "error"; error: string; url?: string };

export default function IbkrSync({ onSynced, label = "Refresh from IBKR", primary }: { onSynced?: (pf: Portfolio) => void; label?: string; primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<Result>();
  const [ok, setOk] = useState<string>();

  const run = async () => {
    setBusy(true);
    setFail(undefined);
    setOk(undefined);
    try {
      const r = await fetch("/api/ibkr", { method: "POST" });
      const d = await r.json();
      if (!r.ok) {
        const st = await fetch("/api/ibkr", { cache: "no-store" }).then((x) => x.json()).catch(() => ({}));
        setFail({ state: d.state ?? "error", error: d.error ?? `HTTP ${r.status}`, url: st.url });
        return;
      }
      const pf = d.portfolio as Portfolio;
      await fetchPortfolio(true).catch(() => null);
      setOk(`${pf.positions.length} positions synced`);
      onSynced?.(pf);
    } catch (e) {
      setFail({ state: "error", error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="ibkr-sync">
      <button className={`btn small ${primary ? "primary" : ""}`} onClick={run} disabled={busy}>
        {busy ? <Spinner /> : "↻"} {label}
      </button>
      {ok && <span className="up small"> {ok}</span>}
      {fail && (
        <div className="ibkr-help small">
          {fail.state === "login" ? (
            <>
              The IBKR gateway is running but not logged in.{" "}
              {fail.url && (
                <a href={fail.url} target="_blank" rel="noreferrer">
                  Log in at {fail.url}
                </a>
              )}
              , then press the button again.
            </>
          ) : fail.state === "down" ? (
            <>
              <b>The IBKR Client Portal Gateway isn&apos;t running{fail.url ? ` at ${fail.url}` : ""}.</b> It&apos;s IBKR&apos;s own small app that lets Dodona read your account on this machine:
              <ol>
                <li>Install Java once (e.g. <code>brew install --cask temurin</code>).</li>
                <li>Download the Client Portal Gateway from IBKR&apos;s Web API page and unzip it.</li>
                <li>In <code>root/conf.yaml</code> set <code>listenPort: 5001</code> (macOS AirPlay already uses 5000).</li>
                <li>Start it: <code>bin/run.sh root/conf.yaml</code>, open https://localhost:5001 and log in.</li>
              </ol>
              Or ask Claude to “sync my IBKR positions” (uses the IBKR connector).
            </>
          ) : (
            <span className="err">{fail.error}</span>
          )}
        </div>
      )}
    </span>
  );
}
