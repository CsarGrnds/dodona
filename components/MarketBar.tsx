"use client";
// The strip at the top of every page: is the NYSE open, and how long until the next bell, in
// New York time and in your own time zone. Ticks every second; computed in the browser.
import { useEffect, useState } from "react";
import { countdown, nextBell } from "@/lib/clock";

const NY = "America/New_York";
const SOON_MS = 15 * 60_000; // last 15 minutes before a bell

function fmtTime(ms: number, tz: string, withDay: boolean) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", ...(withDay ? { weekday: "short" } : {}) }).format(ms);
}
function tzName(ms: number, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(ms).find((p) => p.type === "timeZoneName")?.value ?? tz;
}
const dayKey = (ms: number, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(ms);

export default function MarketBar() {
  const [now, setNow] = useState<number>();
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (now === undefined) return <div className="mbar" aria-hidden />; // rendered only in the browser (time zone, live clock)

  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sameTz = tzName(now, local) === tzName(now, NY);
  const b = nextBell(now);
  const left = b.at - now;
  const soon = left <= SOON_MS;
  const otherDay = dayKey(b.at, local) !== dayKey(now, local);
  const bellLocal = `${fmtTime(b.at, local, otherDay)} ${tzName(b.at, local)}`;
  const bellNy = `${b.kind === "open" && b.date !== dayKey(now, NY) ? `${b.weekday.slice(0, 3)} ` : ""}${b.label} ET`;
  const state = b.open ? (soon ? "closing" : "open") : soon ? "opening" : "closed";

  return (
    <div className={`mbar ${state}`} role="status" aria-live="off">
      <div className="mbar-in">
        <span className="mbar-state">
          <i />
          {b.open ? "Market open" : `Market closed${b.reason && b.reason !== "after the close" && b.reason !== "before the open" ? ` · ${b.reason}` : ""}`}
        </span>
        <span className="mbar-count">
          {b.kind === "open" ? "Opens" : "Closes"} in <b className="mono">{countdown(left)}</b>
        </span>
        <span className="mbar-when">
          {sameTz ? bellNy : <>{bellLocal} <span className="muted">your time</span> · {bellNy}</>}
          {b.early && <span className="caution"> · early close ({b.early})</span>}
        </span>
        <span className="mbar-now muted mono" title={`Your time zone: ${local}`}>
          {sameTz ? `${fmtTime(now, NY, false)} ET` : `${fmtTime(now, local, false)} ${tzName(now, local)} · ${fmtTime(now, NY, false)} ET`}
        </span>
      </div>
      {!b.calendarKnown && <div className="mbar-note">NYSE holidays are only listed for 2026–2027: check the calendar.</div>}
    </div>
  );
}
