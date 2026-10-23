"use client";
import Link from "next/link";
import type { Action, Strategy } from "@/lib/types";

export function Badge({ action, big }: { action: Action; big?: boolean }) {
  return <span className={`badge ${action}${big ? " big" : ""}`}>{action}</span>;
}

export function Confidence({ value }: { value: number }) {
  return (
    <div title={`Confidence ${(value * 100).toFixed(0)}%`}>
      <div className="conf">
        <div style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
    </div>
  );
}

export function StrategyToggle({ value, onChange }: { value: Strategy; onChange: (s: Strategy) => void }) {
  return (
    <div className="seg" role="group" aria-label="Strategy">
      {(["dividend", "swing"] as Strategy[]).map((s) => (
        <button key={s} className={value === s ? "on" : ""} onClick={() => onChange(s)}>
          {s === "dividend" ? "Dividend" : "Swing"}
        </button>
      ))}
    </div>
  );
}

export function Brand({ sub }: { sub?: string }) {
  return (
    <Link href="/" className="brand">
      <h1>
        DOD<span>O</span>NA
      </h1>
      <small>{sub ?? "agentic market oracle"}</small>
    </Link>
  );
}

export function Disclaimer() {
  return (
    <p className="disclaimer">
      Dodona is decision support, not financial advice. Data from Yahoo Finance (unofficial) with Google Finance fallback; may be delayed or wrong. Verify before trading.
    </p>
  );
}

export function Spinner() {
  return <span className="spin" aria-label="loading" />;
}
