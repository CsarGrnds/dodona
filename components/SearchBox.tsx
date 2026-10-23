"use client";
import { useEffect, useRef, useState } from "react";

interface Hit {
  symbol: string;
  name: string;
  exchange?: string;
  type: string;
}

export default function SearchBox({ onPick }: { onPick: (symbol: string) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 1) {
      setHits([]);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
        const data = await res.json();
        setHits(data.results ?? []);
        setActive(0);
        setOpen(true);
      } catch {
        setHits([]);
      }
    }, 250);
  }, [q]);

  const pick = (s: string) => {
    onPick(s.toUpperCase());
    setQ("");
    setHits([]);
    setOpen(false);
  };

  return (
    <div className="search">
      <input
        placeholder="Add a ticker — e.g. KO, Apple, SCHD"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, hits.length - 1));
          if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          if (e.key === "Enter") {
            if (hits[active]) pick(hits[active].symbol);
            else if (q.trim()) pick(q.trim());
          }
        }}
      />
      {open && hits.length > 0 && (
        <ul>
          {hits.map((h, i) => (
            <li key={h.symbol} className={i === active ? "active" : ""} onMouseDown={() => pick(h.symbol)}>
              <span className="mono" style={{ minWidth: 70, fontWeight: 700 }}>{h.symbol}</span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.name}</span>
              <span className="muted small">{h.type === "ETF" ? "ETF · " : ""}{h.exchange}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
