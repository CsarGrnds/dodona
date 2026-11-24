"use client";
// The trade team on an isometric trading floor: each agent at its own desk, the lead in the middle.
// It replays a /trade-desk session from its Claude Code transcript as a conversation: the lead hands a
// task to a specialist (a note flies across the floor), the specialist works at its screen and reports
// back, each line in a speech bubble. Live sessions follow along. Messages run in a side panel; click
// an agent to see only theirs; right-click one to inspect its profile (/agents). Original pixel art, read-only.
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Analysis } from "@/lib/analysis";
import type { TeamStep, TeamTranscript } from "@/lib/data/transcripts";

const TW = 36; // half a tile's width
const TH = 18; // half a tile's height
const OX = 480;
const OY = 104;
const N = 11; // the room is N x N tiles
const P = (i: number, j: number) => ({ x: OX + (i - j) * TW, y: OY + (i + j) * TH });
const pts = (a: Array<{ x: number; y: number }>) => a.map((p) => `${p.x},${p.y}`).join(" ");

interface Seat { label: string; i: number; j: number; shirt: string; hair: string; skin: string; w?: number; fem?: boolean }
export const SEATS: Record<string, Seat> = {
  lead: { label: "Lead trader", i: 4.3, j: 4.5, w: 2.2, shirt: "#7c6cf0", hair: "#2b1d14", skin: "#e0ac83" },
  "trade-screener": { label: "Screener", i: 8.2, j: 9.7, shirt: "#4a9e8e", hair: "#6b4226", skin: "#f0c6a0", fem: true },
  "trade-scanner": { label: "Scanner", i: 1.2, j: 1.4, shirt: "#3aa0d8", hair: "#121212", skin: "#f1c7a3" },
  "trade-news": { label: "News", i: 3.6, j: 0.8, shirt: "#e0884a", hair: "#7a4a1e", skin: "#c58c5f" },
  "trade-chartist": { label: "Chartist", i: 6.1, j: 0.8, shirt: "#2fbf71", hair: "#c98a3a", skin: "#f3d2b5", fem: true },
  "trade-analyst": { label: "Analyst", i: 8.5, j: 1.4, shirt: "#5f6fd6", hair: "#3b2a20", skin: "#8d5a3b" },
  "trade-entry": { label: "Entry", i: 0.8, j: 4.3, shirt: "#d5a43b", hair: "#4a2c19", skin: "#a8714a" },
  "trade-exit": { label: "Exit plan", i: 8.9, j: 4.3, shirt: "#c4577d", hair: "#161616", skin: "#efc09a" },
  "trade-timemachine": { label: "Time Machine", i: 1.2, j: 7.4, shirt: "#8e5bd8", hair: "#b0b0b0", skin: "#d7a27c" },
  "trade-budget": { label: "Budget", i: 3.7, j: 8.4, shirt: "#3fb5a3", hair: "#5a3a22", skin: "#f0caa8" },
  "trade-risk": { label: "Risk", i: 6.1, j: 8.4, shirt: "#e5534b", hair: "#1d1d1d", skin: "#8a5a3a", fem: true },
  "trade-coach": { label: "Coach", i: 8.5, j: 7.4, shirt: "#e8b84a", hair: "#9a5a2a", skin: "#e8b48f" },
};
const keyOf = (a: string) => (SEATS[a] ? a : SEATS[`trade-${a}`] ? `trade-${a}` : "lead");
const DESK_D = 0.7;
const feet = (s: Seat) => P(s.i + (s.w ?? 1.2) / 2, s.j + DESK_D + 0.5);

interface Line { at: string; from: string; to?: string; text: string; kind: "say" | "work" | "hand" | "report" | "warn" }
// a stock the team analyzed in this session (from trader/learning/candidates.jsonl via /api/desk/analysis)
interface Stock { symbol: string; verdict?: "take" | "skip"; chartScore?: number; trigger?: number; target?: number; chart?: string }
const nyDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
const chartUrl = (f: string) => `/api/desk/chart/${encodeURIComponent(f)}`;
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

function linesFrom(steps: TeamStep[]): Line[] {
  const out: Line[] = [];
  for (const s of steps) {
    const from = keyOf(s.agent);
    const title = s.title.replace(/\s+/g, " ").trim();
    if (s.kind === "delegate") {
      const m = /→\s*([a-z-]+)\s*:?\s*(.*)/i.exec(title);
      out.push({ at: s.at, from, to: m ? keyOf(m[1]) : undefined, text: m?.[2] || title, kind: "hand" });
    } else if (s.kind === "report") {
      // the transcript wraps a subagent's report in a hand-back frame: skip it, keep the report's first line
      const body = (s.detail ?? "").replace(/^\[Subagent hand-back\][\s\S]*?The report follows:\s*/, "");
      const first = body.split("\n").map((x) => x.trim().replace(/\*\*/g, "")).find(Boolean);
      const text = first ?? title;
      // the agent's last words and its hand-back are the same report: keep one, sent to the lead
      const last = out[out.length - 1];
      if (last && last.from === from && last.kind === "say" && last.text.slice(0, 40) === text.slice(0, 40)) out.pop();
      out.push({ at: s.at, from, to: "lead", text, kind: "report" });
    } else if (s.kind === "text") out.push({ at: s.at, from, text: title, kind: "say" });
    else if (s.kind === "command" || s.kind === "skill") out.push({ at: s.at, from, text: title, kind: "work" });
    else if (s.kind === "output" && s.ok === false) out.push({ at: s.at, from, text: title.replace(/→.*$/, "didn't work"), kind: "warn" });
  }
  return out;
}

/** What the team says on the floor while the market is closed and no run is going (shown in a loop). */
export const IDLE_LINES: Array<{ from: string; text: string }> = [
  { from: "lead", text: "Market's closed. I'm officially a long-term investor until the bell." },
  { from: "trade-scanner", text: "Scanned every chart for breakouts. Found one: a breakout of silence." },
  { from: "trade-news", text: "Breaking news: nothing is breaking." },
  { from: "trade-chartist", text: "This flat line is the cleanest chart I've seen all week. 5/5." },
  { from: "trade-timemachine", text: "Ran 10,000 simulations of tonight. The market stayed closed in all of them." },
  { from: "trade-risk", text: "Risk check on a nap: PASS." },
  { from: "trade-budget", text: "Sized the coffee order. Bound by the max-loss rule: one cup." },
  { from: "trade-entry", text: "Entry signal: the opening bell. Until then I'm waiting on a completed bar of sleep." },
  { from: "trade-exit", text: "Stop set at 'bed'. Target: breakfast." },
  { from: "trade-analyst", text: "Read three 10-Qs for fun. Don't tell anyone." },
  { from: "trade-screener", text: "Shortlist for tonight: pillow, blanket, snacks. All liquid, none stretched." },
  { from: "trade-coach", text: "New playbook lesson: rest is a position too." },
];

export function TradingFloor({ session, idle }: { session?: string; idle?: { title: string; note: string; onReplay?: () => void } }) {
  const isIdle = !!idle;
  const [tx, setTx] = useState<TeamTranscript>();
  const [live, setLive] = useState(false);
  const [win, setWin] = useState<{ start: string; end?: string }>(); // the session's time window
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [spy, setSpy] = useState<string>(); // the market chart the team read in this session
  const [models, setModels] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string>();
  const [at, setAt] = useState(0);
  const [play, setPlay] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [pick, setPick] = useState<string>(); // an agent clicked on the floor: only its messages
  const [menu, setMenu] = useState<{ k: string; x: number; y: number }>(); // right-click on a desk
  const router = useRouter();
  const logRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    let on = true;
    let timer: ReturnType<typeof setTimeout>;
    let first = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/desk/team${session ? `?session=${encodeURIComponent(session)}` : ""}`, { cache: "no-store" });
        const j = await r.json();
        if (!on) return;
        if (!r.ok) setErr(j.error ?? `HTTP ${r.status}`);
        else {
          setErr(undefined);
          // first load of a session: stop on its latest message; a live session plays on from there
          if (first) {
            first = false;
            setAt(Math.max(0, linesFrom(j.transcript?.steps ?? []).length - 1));
            setPlay(j.session?.status === "running");
          }
          setTx(j.transcript);
          setModels(j.models ?? {});
          setLive(j.session?.status === "running");
          if (j.session?.startedAt) setWin((w) => (w?.start === j.session.startedAt && w?.end === j.session.endedAt ? w : { start: j.session.startedAt, end: j.session.endedAt }));
          if (j.session?.status === "running") timer = setTimeout(load, 3_000);
        }
      } catch {
        if (on) setErr("Couldn't read the team's session.");
      }
    };
    setPlay(false);
    setPick(undefined);
    load();
    return () => {
      on = false;
      clearTimeout(timer);
    };
  }, [session]);

  // the stocks analyzed in this session: candidates logged between its start and end (a minute's slack)
  useEffect(() => {
    if (!win) return;
    let on = true;
    const from = Date.parse(win.start) - 60_000;
    const to = (win.end ? Date.parse(win.end) : Date.now()) + 60_000;
    fetch(`/api/desk/analysis?date=${nyDay(win.start)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : undefined))
      .then((a: Analysis | undefined) => {
        if (!on || !a) return;
        const runs = (a.date === nyDay(win.start) ? a.runs : []).filter((r) => r.cards.some((c) => Date.parse(c.at) >= from && Date.parse(c.at) <= to));
        const seen = new Map<string, Stock>();
        for (const r of [...runs].reverse())
          for (const c of [...r.cards].reverse())
            if (Date.parse(c.at) >= from && Date.parse(c.at) <= to) seen.set(c.symbol, { symbol: c.symbol, verdict: c.verdict, chartScore: c.chartScore, trigger: c.trigger, target: c.target, chart: c.chart });
        setStocks([...seen.values()]);
        setSpy(runs.find((r) => r.marketChart)?.marketChart);
      })
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [win]);

  const lines = useMemo<Line[]>(() => (isIdle ? IDLE_LINES.map((l) => ({ at: "", from: l.from, text: l.text, kind: "say" })) : linesFrom(tx?.steps ?? [])), [tx, isIdle]);
  // closed floor: the jokes play on a loop from the start; a session (picked or live) shows its own lines
  const wasIdle = useRef(false);
  useEffect(() => {
    setPick(undefined);
    if (isIdle) {
      setAt(0);
      setPlay(true);
    } else if (wasIdle.current) {
      // back from the closed floor: stop on the session's latest message, like a first load
      setAt(Math.max(0, linesFrom(tx?.steps ?? []).length - 1));
      setPlay(live);
    }
    wasIdle.current = isIdle;
    // only when the floor opens or closes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isIdle]);
  // no logged candidates (a paper or review run): the symbols the lead handed out, e.g. "Chart score for COO"
  const tape: Stock[] = useMemo(() => {
    if (stocks.length) return stocks;
    const syms = new Set<string>();
    for (const l of lines) if (l.kind === "hand") for (const m of l.text.matchAll(/\b(?:for|on)\s+([A-Z]{1,5})\b/g)) syms.add(m[1]);
    return [...syms].map((symbol) => ({ symbol }));
  }, [stocks, lines]);
  const present = useMemo(() => new Set(isIdle ? Object.keys(SEATS) : ["lead", ...(tx?.agents ?? []).map((a) => keyOf(a.agent))]), [tx, isIdle]);

  const involves = (l: Line, k?: string) => !k || l.from === k || l.to === k;
  const mine = useMemo(() => lines.map((l, i) => ({ l, i })).filter((x) => involves(x.l, pick)), [lines, pick]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    if (isIdle) return m;
    for (const l of lines) for (const k of new Set([l.from, l.to].filter(Boolean) as string[])) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  }, [lines]);
  const usage = useMemo(() => new Map((tx?.agents ?? []).filter((a) => a.usage).map((a) => [keyOf(a.agent), a.usage!])), [tx]);

  // playback: one line every ~2 s (only the picked agent's lines when one is picked); a live session
  // waits at the newest line for the next one
  useEffect(() => {
    const next = mine.find((x) => x.i > at)?.i ?? (isIdle && lines.length ? 0 : undefined);
    if (!play || next === undefined) return;
    const cur = lines[at];
    const ms = (isIdle ? 4200 : cur?.kind === "work" ? 1300 : 2600) / speed;
    const id = setTimeout(() => setAt(next), ms);
    return () => clearTimeout(id);
  }, [play, at, lines, mine, speed, isIdle]);

  // keep the current message in view inside the side panel (never scrolls the page)
  useEffect(() => {
    const ol = logRef.current;
    const li = ol?.querySelector<HTMLElement>("li.now");
    if (ol && li) ol.scrollTo({ top: li.offsetTop - ol.clientHeight / 2 + li.offsetHeight / 2, behavior: "smooth" });
  }, [at, pick, lines.length]);

  const choose = (k: string) => {
    const nk = pick === k ? undefined : k;
    setPick(nk);
    if (nk) {
      // jump to this agent's first line at or after the current one (else its first)
      const first = lines.findIndex((l, i) => i >= at && involves(l, nk));
      const any = lines.findIndex((l) => involves(l, nk));
      if (first >= 0 || any >= 0) setAt(first >= 0 ? first : any);
    }
  };

  // the right-click menu closes on any click, scroll or Escape
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("click", close); window.removeEventListener("scroll", close, true); window.removeEventListener("keydown", esc); };
  }, [menu]);

  if (err) return <div className="dk-empty">{err}</div>;
  if (!tx && !isIdle) return <div className="fl-wrap fl-loading" />;

  const cur = lines[at];
  const prev = at > 0 ? lines[at - 1] : undefined;
  const busy = cur ? cur.from : undefined;
  const fly = cur && cur.to && (cur.kind === "hand" || cur.kind === "report") ? { a: feet(SEATS[cur.from]), b: feet(SEATS[cur.to]) } : undefined;
  const order = Object.entries(SEATS).sort((a, b) => a[1].i + a[1].j - (b[1].i + b[1].j));
  const shown = cur && involves(cur, pick) ? cur : undefined;
  const pu = pick ? usage.get(pick) : undefined;
  // the LED tape: the stocks this session analyzed, with their levels, chart score and verdict
  const head = isIdle ? (idle?.title.startsWith("Between") ? "■ ON BREAK   " : "■ CLOSED   ") : `${live ? "● LIVE" : "▶ REPLAY"} ${win ? new Date(win.start).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) + " ET" : ""}   `;
  const items = isIdle
    ? [{ sym: idle.title.toUpperCase(), lv: "", sc: "", v: undefined }]
    : tape.length
    ? tape.map((t) => ({ sym: t.symbol, lv: t.trigger !== undefined && t.target !== undefined ? ` ${t.trigger.toFixed(2)}→${t.target.toFixed(2)}` : "", sc: t.chartScore !== undefined ? ` CHART ${t.chartScore}/5` : "", v: t.verdict }))
    : [{ sym: "NO STOCKS ANALYZED IN THIS SESSION", lv: "", sc: "", v: undefined }];
  const tapeLen = head.length + items.reduce((a, x) => a + x.sym.length + x.lv.length + x.sc.length + (x.v ? 5 : 0) + 5, 0);
  const tapePx = tapeLen * 6.6; // 10px mono with letter spacing
  const screens: Array<{ chart?: string; label: string; v?: "take" | "skip"; sc?: number }> = isIdle ? [] : [
    ...(spy ? [{ chart: spy, label: "SPY · MARKET" }] : []),
    ...tape
      .filter((t) => t.chart)
      .sort((a, b) => Number(b.verdict === "take") - Number(a.verdict === "take") || (b.chartScore ?? 0) - (a.chartScore ?? 0))
      .map((t) => ({ chart: t.chart, label: t.symbol, v: t.verdict, sc: t.chartScore })),
  ].slice(0, 3);

  const H = 104; // wall height
  const wall = { a: P(0, 0), b: P(N, 0), c: P(0, N) };
  const upw = (p: { x: number; y: number }, d: number) => ({ x: p.x, y: p.y - d });
  return (
    <div className="fl-wrap">
      {menu && (
        <div className="fl-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 110) }} onClick={(e) => e.stopPropagation()}>
          <div className="fl-menu-h">{SEATS[menu.k].label}</div>
          <button role="menuitem" autoFocus onClick={() => { setMenu(undefined); router.push(`/agents?agent=${menu.k}`); }}>Inspect profile…</button>
          <button role="menuitem" onClick={() => { setMenu(undefined); choose(menu.k); }}>{pick === menu.k ? "Show everyone's messages" : "Show only their messages"}</button>
        </div>
      )}
      <div className="fl-main">
        <svg viewBox="76 -6 808 512" className="fl-svg" role="img" aria-label="The trade team on its trading floor">
          <defs>
            <linearGradient id="fl-g-suit" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#3d4865" />
              <stop offset="1" stopColor="#1a2030" />
            </linearGradient>
            <linearGradient id="fl-g-suitside" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#323b55" />
              <stop offset="1" stopColor="#151a27" />
            </linearGradient>
            <linearGradient id="fl-g-desktop" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#6a758c" />
              <stop offset="1" stopColor="#3a4253" />
            </linearGradient>
            <linearGradient id="fl-g-deskfront" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#2a303d" />
              <stop offset="1" stopColor="#12151c" />
            </linearGradient>
            <linearGradient id="fl-g-deskside" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#1c212b" />
              <stop offset="1" stopColor="#0d1015" />
            </linearGradient>
            <linearGradient id="fl-g-chair" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#353b48" />
              <stop offset="1" stopColor="#0f1116" />
            </linearGradient>
            <linearGradient id="fl-g-bezel" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#3a404c" />
              <stop offset="1" stopColor="#0b0d12" />
            </linearGradient>
            <linearGradient id="fl-g-screen" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#0f3566" />
              <stop offset="1" stopColor="#06142a" />
            </linearGradient>
            <linearGradient id="fl-g-glare" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#fff" stopOpacity=".28" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
            <radialGradient id="fl-r-shadow">
              <stop offset="0" stopColor="#000" stopOpacity=".6" />
              <stop offset="1" stopColor="#000" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="fl-r-glow">
              <stop offset="0" stopColor="#4aa3ff" stopOpacity=".45" />
              <stop offset="1" stopColor="#4aa3ff" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="fl-r-light">
              <stop offset="0" stopColor="#fff4d6" stopOpacity=".13" />
              <stop offset="1" stopColor="#fff4d6" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="fl-r-vignette">
              <stop offset="0" stopColor="#000" stopOpacity="0" />
              <stop offset="1" stopColor="#000" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="fl-g-pot" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#4a5163" />
              <stop offset=".45" stopColor="#2e3340" />
              <stop offset="1" stopColor="#15181f" />
            </linearGradient>
            <clipPath id="fl-tick-clip">
              <rect x="0" y="0" width={N * TW - 8} height="16" />
            </clipPath>
            <linearGradient id="fl-night" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#0d1a33" />
              <stop offset="1" stopColor="#24375e" />
            </linearGradient>
          </defs>
          {/* walls */}
          <polygon points={pts([wall.a, wall.b, upw(wall.b, H), upw(wall.a, H)])} className="fl-wall r" />
          <polygon points={pts([wall.a, wall.c, upw(wall.c, H), upw(wall.a, H)])} className="fl-wall l" />
          {/* left wall: floor-to-ceiling windows on a night skyline */}
          {[0.4, 3.9, 7.4].map((j) => (
            <g key={j} transform={`matrix(1,-0.5,0,1,${P(0, j + 3.2).x},${P(0, j + 3.2).y - H + 14})`}>
              <rect width={3.1 * TW} height={H - 30} fill="url(#fl-night)" className="fl-glass" />
              {[6, 22, 34, 52, 66, 80, 94].map((x, n) => (
                <rect key={x} x={x} y={H - 30 - (18 + ((n * 23) % 34))} width="12" height={18 + ((n * 23) % 34)} className="fl-tower" />
              ))}
              {[10, 26, 38, 56, 70, 84, 98].map((x, n) => (
                <rect key={x} x={x} y={H - 24 - ((n * 17) % 26)} width="2" height="2" className="fl-lit" />
              ))}
              <line x1={1.55 * TW} y1="0" x2={1.55 * TW} y2={H - 30} className="fl-mullion" />
              <polygon points={`8,0 ${0.9 * TW},0 18,${H - 30} 0,${H - 30} 0,${H - 50}`} fill="#fff" opacity=".07" />
              <rect width={3.1 * TW} height={H - 30} className="fl-pane" />
            </g>
          ))}
          {/* right wall: three big screens with the charts this session read, spread evenly, and the LED tape */}
          <g transform={`matrix(1,0.5,0,1,${wall.a.x},${wall.a.y - H + 30})`}>
            {[0, 1, 2].map((c) => {
              const sc = screens[c];
              const SW = 104;
              const SH = 58;
              const x = 10 + c * (SW + 14); // leaves the far corner for the plant
              return (
                <g key={c} transform={`translate(${x},0)`}>
                  <clipPath id={`fl-vw-${c}`}>
                    <rect width={SW} height={SH} />
                  </clipPath>
                  <rect x="-3" y="-3" width={SW + 6} height={SH + 6} rx="3" className="fl-vw-frame" />
                  <rect width={SW} height={SH} className="fl-vw" />
                  {sc?.chart ? (
                    <g clipPath={`url(#fl-vw-${c})`}>
                      <image href={chartUrl(sc.chart)} x="0" y="-4" width={SW} height={SH + 10} preserveAspectRatio="xMidYMid slice" />
                      <rect y={SH - 14} width={SW} height="14" fill="#000" opacity=".75" />
                      <text x="5" y={SH - 4} className="fl-vw-sym">{sc.label}</text>
                      {sc.v && <text x={SW - 5} y={SH - 4} className={`fl-vw-v ${sc.v}`}>{sc.sc !== undefined ? `${sc.sc}/5 ` : ""}{sc.v.toUpperCase()}</text>}
                    </g>
                  ) : (
                    <>
                      <g transform={`scale(${SW / 58},${SH / 30})`}>
                        <polyline points={WAVES[c % WAVES.length]} className={`fl-vw-line ${c === 1 ? "down" : ""}`} />
                      </g>
                      <text x={SW / 2} y={SH - 6} className="fl-vw-idle">DODONA</text>
                    </>
                  )}
                  <polygon points={`0,0 ${SW * 0.35},0 ${SW * 0.12},${SH} 0,${SH}`} fill="url(#fl-g-glare)" opacity=".55" />
                  <rect x={SW / 2 - 6} y={SH + 3} width="12" height="2.5" fill="#33d17a" opacity=".8" />
                </g>
              );
            })}
          </g>
          <g transform={`matrix(1,0.5,0,1,${wall.a.x + 4},${wall.a.y - H + 4})`}>
            <rect width={N * TW - 8} height="16" className="fl-tick-bg" />
            <g clipPath="url(#fl-tick-clip)">
              <text y="12" className="fl-tick">
                {[0, 1, 2].map((rep) => (
                  <tspan key={rep}>
                    <tspan className="fl-tick-head">{head}</tspan>
                    {items.map((x, n) => (
                      <tspan key={n}>
                        <tspan className="fl-tick-sym">{x.sym}</tspan>
                        <tspan>{x.lv}</tspan>
                        <tspan className="fl-tick-sc">{x.sc}</tspan>
                        {x.v && <tspan className={`fl-tick-v ${x.v}`}> {x.v.toUpperCase()}</tspan>}
                        <tspan className="fl-tick-sep">{"  ◆  "}</tspan>
                      </tspan>
                    ))}
                  </tspan>
                ))}
                <animateTransform attributeName="transform" type="translate" from="0 0" to={`${-tapePx} 0`} dur={`${Math.max(8, tapeLen / 7)}s`} repeatCount="indefinite" />
              </text>
            </g>
          </g>
          {/* floor: charcoal carpet tiles, a walkway around the lead's desk */}
          {Array.from({ length: N * N }, (_, k) => {
            const i = k % N;
            const j = Math.floor(k / N);
            return <polygon key={k} points={pts([P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)])} className={`fl-tile ${(i + j) % 2 ? "b" : "a"}`} />;
          })}
          <polygon points={pts([P(3.5, 3.7), P(7.3, 3.7), P(7.3, 7), P(3.5, 7)])} className="fl-rug" />

          {/* light pools from the ceiling */}
          {[[3, 3], [7.6, 3], [3, 7.8], [7.6, 7.8], [5.4, 5.6]].map(([i, j]) => (
            <ellipse key={`${i}-${j}`} cx={P(i, j).x} cy={P(i, j).y} rx="120" ry="60" fill="url(#fl-r-light)" />
          ))}
          <Plant p={P(0.75, 0.75)} />
          <Plant p={P(10.4, 0.6)} />
          <Plant p={P(0.6, 10.4)} />

          {order.map(([k, s]) => (
            <Desk
              key={k}
              k={k}
              s={s}
              here={present.has(k)}
              busy={busy === k}
              talking={cur?.from === k || (cur?.to === k && cur.kind === "hand")}
              model={models[k]}
              n={counts.get(k) ?? 0}
              picked={pick === k}
              dim={!!pick && pick !== k && !(cur && involves(cur, pick) && (cur.from === k || cur.to === k))}
              onPick={() => choose(k)}
              onMenu={(x, y) => setMenu({ k, x, y })}
            />
          ))}

          {/* a note flying between desks */}
          {fly && shown && (
            <g key={`fly-${at}`}>
              <path d={arc(fly.a, fly.b)} className={`fl-arc ${cur!.kind}`} />
              <g className="fl-note">
                <rect x="-8" y="-6" width="16" height="12" rx="1" />
                <polyline points="-8,-6 0,1 8,-6" />
                <animateMotion dur={`${1.4 / speed}s`} fill="freeze" path={arc(fly.a, fly.b)} />
              </g>
            </g>
          )}

          {/* speech bubbles: the line before fades, the current one on top */}
          {!pick && prev && prev.from !== cur?.from && <Bubble key={`p-${at}`} line={prev} faded />}
          {shown && <Bubble key={`c-${at}`} line={shown} />}
        </svg>

        <div className="fl-bar" hidden={isIdle}>
          <button className="btn ghost" onClick={() => { setAt(pick ? mine[0]?.i ?? 0 : 0); setPlay(true); }} title="From the start">⏮</button>
          <button className="btn ghost" onClick={() => setPlay(!play)} title={play ? "Pause" : "Play"}>{play ? "❚❚" : "▶"}</button>
          <button className="btn ghost" onClick={() => { setAt(pick ? mine[mine.length - 1]?.i ?? at : lines.length - 1); setPlay(true); }} title="Latest">⏭</button>
          <input type="range" min={0} max={Math.max(0, lines.length - 1)} value={at} onChange={(e) => { setAt(Number(e.target.value)); setPlay(false); }} aria-label="Scrub through the session" />
          <span className="small muted mono">{lines.length ? at + 1 : 0}/{lines.length}</span>
          <div className="seg">
            {[1, 2, 4].map((x) => <button key={x} className={speed === x ? "on" : ""} onClick={() => setSpeed(x)}>{x}×</button>)}
          </div>
        </div>
      </div>

      {isIdle ? (
        <aside className="fl-side fl-closed" aria-label="Floor closed">
          <div className="fl-side-head">
            <b>{idle.title}</b>
          </div>
          <p className="small muted">{idle.note}</p>
          <p className="small muted">The team&apos;s messages show here again as soon as a run starts. Every past session&apos;s log stays in Claude&apos;s session, below.</p>
          {idle.onReplay && <button className="btn" onClick={idle.onReplay}>▶ Replay the last session</button>}
        </aside>
      ) : (
      <aside className="fl-side" aria-label="Messages">
        {pick ? (
          <div className="fl-pick" style={{ borderColor: SEATS[pick].shirt }}>
            <div className="row" style={{ gap: 8 }}>
              <span className="fl-dot" style={{ background: SEATS[pick].shirt }} />
              <b>{SEATS[pick].label}</b>
              {models[pick] && <span className="pill">{models[pick].replace(/^claude-/, "")}</span>}
              <span className="spacer" />
              <button className="btn ghost" onClick={() => setPick(undefined)} title="Show everyone's messages">✕</button>
            </div>
            <div className="small muted">
              {mine.length} message{mine.length === 1 ? "" : "s"}
              {pu ? ` · ${pu.calls} model calls${pu.costUsd !== undefined ? ` · ≈$${pu.costUsd.toFixed(2)} at API prices` : ""}` : ""}
            </div>
          </div>
        ) : (
          <div className="fl-side-head">
            <b>Messages</b>
            <span className="small muted">{lines.length} · click an agent to filter</span>
          </div>
        )}
        {lines.length === 0 ? (
          <div className="dk-empty">The floor is quiet: this session has no conversation yet.</div>
        ) : (
          <ol className="fl-log" ref={logRef}>
            {pick && mine.length === 0 && <li className="small muted">{SEATS[pick].label} has no messages in this session.</li>}
            {mine.map(({ l, i }) => (
              <li
                key={`${l.at}-${i}`}
                className={`${i === at ? "now" : ""} ${i > at ? "later" : ""} ${l.kind}`}
                style={{ borderLeftColor: SEATS[l.from].shirt }}
                onClick={() => { setAt(i); setPlay(false); }}
                title="Show this moment on the floor"
              >
                <div className="fl-log-who small">
                  <button className="fl-who" onClick={(e) => { e.stopPropagation(); choose(l.from); }}>{SEATS[l.from].label}</button>
                  {l.to ? <> → <button className="fl-who" onClick={(e) => { e.stopPropagation(); choose(l.to!); }}>{SEATS[l.to].label}</button></> : null}
                  <span className="spacer" />
                  <span className="muted mono">{new Date(l.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>
                </div>
                <div className="small">{l.kind === "work" ? <span className="muted">⚙ {clip(l.text, 140)}</span> : clip(l.text, 240)}</div>
              </li>
            ))}
          </ol>
        )}
      </aside>
      )}
    </div>
  );
}

const WAVES = ["3,22 10,18 17,20 24,12 31,15 38,9 45,11 55,6", "3,8 12,12 20,10 28,17 36,15 44,21 55,24", "3,18 10,20 18,13 26,16 34,10 42,14 55,9", "3,12 11,10 19,15 27,13 35,19 43,16 55,20"];
const arc = (a: { x: number; y: number }, b: { x: number; y: number }) => `M${a.x},${a.y - 34} Q${(a.x + b.x) / 2},${Math.min(a.y, b.y) - 110} ${b.x},${b.y - 34}`;
const OUT = "#05070c"; // the dark outline every shape gets

function Desk({ k, s, here, busy, talking, model, n, picked, dim, onPick, onMenu }: { k: string; s: Seat; here: boolean; busy: boolean; talking: boolean; model?: string; n: number; picked: boolean; dim: boolean; onPick: () => void; onMenu: (x: number, y: number) => void }) {
  const w = s.w ?? 1.2;
  const h = 16;
  const up = (p: { x: number; y: number }, d = h) => ({ x: p.x, y: p.y - d });
  const at = (a: number, b: number, d = h) => up(P(s.i + a, s.j + b), d);
  const top = [at(0, 0), at(w, 0), at(w, DESK_D), at(0, DESK_D)];
  const front = [P(s.i, s.j + DESK_D), P(s.i + w, s.j + DESK_D), at(w, DESK_D), at(0, DESK_D)];
  const side = [P(s.i + w, s.j), P(s.i + w, s.j + DESK_D), at(w, DESK_D), at(w, 0)];
  const f = feet(s);
  const c = P(s.i + w / 2, s.j + DESK_D / 2);
  const label = model ? model.replace(/^claude-/, "").split("-")[0] : undefined;
  const on = busy || (k === "lead" && here);
  // a row of screens along the back of the desk: 2 for a specialist, 4 for the lead
  const screens = k === "lead" ? [0.25, 0.75, 1.25, 1.75].map((t) => (t / 2) * w) : [0.3, 0.9].map((t) => t * w);
  const chair = (a: number, d: number) => up(P(s.i + w / 2 + a, s.j + DESK_D + 0.28), d);
  const kb = w / 2;
  return (
    <g
      className={`fl-seat ${here ? "" : "away"} ${busy ? "busy" : ""} ${picked ? "picked" : ""} ${dim ? "dim" : ""}`}
      data-agent={k}
      role="button"
      tabIndex={0}
      aria-pressed={picked}
      aria-label={`${s.label}: ${n} message${n === 1 ? "" : "s"}. Show only theirs`}
      onClick={onPick}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") (e.preventDefault(), onPick());
        else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(r.left + r.width / 2, r.top + r.height / 2);
        }
      }}
    >
      {/* soft shadow under the desk */}
      <ellipse cx={c.x} cy={c.y + 4} rx={w * 34 + 14} ry={w * 13 + 8} fill="url(#fl-r-shadow)" />
      {picked && <ellipse cx={f.x} cy={f.y} rx="32" ry="14" className="fl-ring" style={{ stroke: s.shirt }} />}
      {/* office chair: base, seat, back with a headrest */}
      <line x1={chair(0, 0).x - 9} y1={chair(0, 0).y} x2={chair(0, 0).x + 9} y2={chair(0, 0).y} stroke="#0a0c10" strokeWidth="2.5" strokeLinecap="round" />
      <rect x={chair(0, 0).x - 1.5} y={chair(0, 14).y} width="3" height="14" fill="#14171d" />
      <polygon points={pts([chair(-0.26, 14), chair(0.26, 14), chair(0.26, 44), chair(-0.26, 44)])} fill="url(#fl-g-chair)" stroke={OUT} strokeWidth="1" />
      <polygon points={pts([chair(-0.16, 44), chair(0.16, 44), chair(0.16, 52), chair(-0.16, 52)])} fill="url(#fl-g-chair)" stroke={OUT} strokeWidth="1" />
      <line x1={chair(-0.2, 40).x} y1={chair(-0.2, 40).y} x2={chair(0.2, 40).x} y2={chair(0.2, 40).y} stroke="#4a5160" strokeWidth="1" opacity=".7" />
      {/* the desk */}
      <polygon points={pts(top)} fill="url(#fl-g-desktop)" stroke={OUT} strokeWidth="1" />
      <polygon points={pts(front)} fill="url(#fl-g-deskfront)" stroke={OUT} strokeWidth="1" />
      <polygon points={pts(side)} fill="url(#fl-g-deskside)" stroke={OUT} strokeWidth="1" />
      <polyline points={pts([at(0, DESK_D), at(w, DESK_D)])} className="fl-edge" />
      <polyline points={pts([at(0, DESK_D, h - 3), at(w, DESK_D, h - 3)])} className="fl-trim" style={{ stroke: s.shirt }} />
      {/* light from the screens on the desk */}
      {on && <ellipse cx={c.x} cy={at(w / 2, 0.35).y} rx={w * 30} ry="9" fill="url(#fl-r-glow)" className="fl-cast" />}
      {/* keyboard, mouse and a mug */}
      <polygon points={pts([at(kb - 0.28, 0.42, h + 0.5), at(kb + 0.22, 0.42, h + 0.5), at(kb + 0.22, 0.6, h + 0.5), at(kb - 0.28, 0.6, h + 0.5)])} fill="#11141a" stroke="#3a4150" strokeWidth=".8" />
      <polyline points={pts([at(kb - 0.22, 0.51, h + 1), at(kb + 0.16, 0.51, h + 1)])} stroke="#4c5566" strokeWidth=".8" strokeDasharray="1.5 1" />
      <ellipse cx={at(kb + 0.36, 0.52).x} cy={at(kb + 0.36, 0.52).y} rx="2.4" ry="1.6" fill="#1b1f27" stroke="#3a4150" strokeWidth=".6" />
      <g transform={`translate(${at(w - 0.14, 0.5).x},${at(w - 0.14, 0.5).y})`}>
        <rect x="-2.5" y="-6" width="5" height="6" rx="1" fill="#e9ecf2" stroke={OUT} strokeWidth=".7" />
        <rect x="-2.5" y="-6" width="5" height="1.5" fill={s.shirt} />
        <path d="M2.5,-4.5 h1.5 v2.5 h-1.5" fill="none" stroke="#e9ecf2" strokeWidth="1" />
      </g>
      {/* screens */}
      {screens.map((t, n2) => {
        const m = at(t, 0.18);
        return (
          <g key={n2} transform={`translate(${m.x - 13},${m.y - 25})`}>
            <polygon points="9,25 17,25 15,18 11,18" fill="url(#fl-g-bezel)" />
            <rect width="26" height="19" rx="1.6" fill="url(#fl-g-bezel)" stroke={OUT} strokeWidth="1" />
            <rect x="2" y="2" width="22" height="14.5" fill={on ? "url(#fl-g-screen)" : "#0d1524"} />
            {on && (
              <g className="fl-candles">
                {CANDLES[(n2 + k.length) % CANDLES.length].map(([x, o, cl, hi, lo], q) => (
                  <g key={q}>
                    <line x1={x + 1} y1={hi} x2={x + 1} y2={lo} stroke={cl < o ? "#3ee08a" : "#ff6259"} strokeWidth=".6" />
                    <rect x={x} y={Math.min(o, cl)} width="2" height={Math.max(1, Math.abs(o - cl))} fill={cl < o ? "#3ee08a" : "#ff6259"} />
                  </g>
                ))}
              </g>
            )}
            <polygon points="2,2 11,2 4,16.5 2,16.5" fill="url(#fl-g-glare)" />
            <rect x="12" y="17" width="2" height=".8" fill={on ? "#3ee08a" : "#2a2f3a"} />
          </g>
        );
      })}
      <Person x={f.x} y={f.y} s={s} active={talking} away={!here} />
      {/* name tag */}
      <g transform={`translate(${f.x},${f.y + 17})`}>
        <rect x={-(s.label.length * 3.4 + 8)} y="-9" width={s.label.length * 6.8 + 16} height="14" rx="3" className="fl-tag" style={{ fill: s.shirt }} />
        <rect x={-(s.label.length * 3.4 + 7)} y="-8" width={s.label.length * 6.8 + 14} height="5" rx="2" fill="#fff" opacity=".22" />
        <text y="2" className="fl-name">{s.label}</text>
      </g>
      {label && here && <text x={f.x} y={f.y + 32} className="fl-model">{label}</text>}
      {n > 0 && (
        <g transform={`translate(${f.x + 16},${f.y - 64})`} className="fl-count">
          <rect x="-10" y="-8" width="20" height="15" rx="7.5" />
          <text x="0" y="3.5">{n > 99 ? "99" : n}</text>
        </g>
      )}
      {/* a bigger, invisible hit area so the whole desk and person are easy to click */}
      <polygon points={pts([up(P(s.i - 0.1, s.j - 0.1), 50), up(P(s.i + w + 0.1, s.j - 0.1), 50), P(s.i + w + 0.1, s.j + DESK_D + 1), P(s.i - 0.1, s.j + DESK_D + 1)])} className="fl-hit" />
    </g>
  );
}

// candles on a screen: [x, open, close, high, low] in screen pixels (decoration, not data)
const CANDLES: Array<Array<[number, number, number, number, number]>> = [
  [[3, 12, 10, 13, 9], [6, 10, 11, 12, 8], [9, 11, 8, 12, 7], [12, 8, 9, 10, 6], [15, 9, 6, 10, 5], [18, 6, 5, 7, 4], [21, 5, 6, 7, 4]],
  [[3, 6, 8, 5, 9], [6, 8, 7, 6, 10], [9, 7, 10, 6, 11], [12, 10, 12, 9, 13], [15, 12, 11, 10, 14], [18, 11, 13, 10, 14], [21, 13, 14, 12, 15]],
  [[3, 10, 9, 11, 8], [6, 9, 11, 8, 12], [9, 11, 8, 12, 7], [12, 8, 7, 9, 6], [15, 7, 9, 6, 10], [18, 9, 6, 10, 5], [21, 6, 4, 7, 3]],
];

/**
 * One agent's doll on its own, the same drawing as on the floor (for the Agents page). `active` gives the
 * talking pose: headset, hop and a glow in the shirt colour.
 */
export function Doll({ agent, size = 72, active = false, title }: { agent: string; size?: number; active?: boolean; title?: string }) {
  const s = SEATS[agent] ?? SEATS.lead;
  return (
    <svg className="doll" width={size} height={size * 1.4} viewBox="-24 -62 48 67" role="img" aria-label={title ?? s.label}>
      <defs>
        <linearGradient id="fl-g-suit" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3d4865" />
          <stop offset="1" stopColor="#1a2030" />
        </linearGradient>
        <linearGradient id="fl-g-suitside" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#323b55" />
          <stop offset="1" stopColor="#151a27" />
        </linearGradient>
        <radialGradient id="fl-r-shadow">
          <stop offset="0" stopColor="#000" stopOpacity=".6" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
      </defs>
      <Person x={0} y={0} s={s} active={active} away={false} />
    </svg>
  );
}

function Person({ x, y, s, active, away }: { x: number; y: number; s: Seat; active: boolean; away: boolean }) {
  const o = { stroke: OUT, strokeWidth: 0.9 } as const;
  const fem = !!s.fem;
  return (
    <g className={`fl-person ${active ? "active" : ""}`} transform={`translate(${x},${y})`}>
      {active && <ellipse cx="0" cy="0" rx="19" ry="7.5" className="fl-glow" style={{ fill: s.shirt }} />}
      <ellipse cx="0" cy="0" rx="13" ry="4.8" fill="url(#fl-r-shadow)" />
      <g className="fl-body">
        {/* legs and shoes */}
        {fem ? (
          <>
            <rect x="-5.5" y="-12" width="4" height="11" fill="#2a2430" {...o} />
            <rect x="1.5" y="-12" width="4" height="11" fill="#2a2430" {...o} />
            <rect x="-6.5" y="-2" width="5.5" height="2.5" rx="1" fill="#0b0c10" />
            <rect x="1" y="-2" width="5.5" height="2.5" rx="1" fill="#0b0c10" />
            <polygon points="-8,-21 8,-21 9,-11 -9,-11" fill="url(#fl-g-suit)" {...o} />
          </>
        ) : (
          <>
            <rect x="-6" y="-15" width="5" height="14" fill="#1b2130" {...o} />
            <rect x="1" y="-15" width="5" height="14" fill="#232a3c" {...o} />
            <line x1="-3.5" y1="-14" x2="-3.5" y2="-2" stroke="#2e3650" strokeWidth=".6" />
            <rect x="-7" y="-2.5" width="6" height="3" rx="1" fill="#0b0c10" />
            <rect x="1" y="-2.5" width="6" height="3" rx="1" fill="#0b0c10" />
            <rect x="-6" y="-2.3" width="3" height=".8" fill="#4a4f5c" />
          </>
        )}
        {/* jacket with lapels; shading on the right */}
        <polygon points="-9,-34 9,-34 8.5,-14 -8.5,-14" fill="url(#fl-g-suit)" {...o} />
        {fem ? (
          <>
            <polygon points="-4,-34 4,-34 0,-25" fill={s.shirt} />
            <circle cx="0" cy="-28.5" r=".9" fill="#f3d27a" />
          </>
        ) : (
          <>
            <polygon points="-4,-34 4,-34 0,-25" fill="#f4f6fb" />
            <polygon points="-1.4,-31 1.4,-31 2,-19 0,-17 -2,-19" fill={s.shirt} stroke={OUT} strokeWidth=".6" />
            <rect x="-1.4" y="-32.5" width="2.8" height="2" fill={s.shirt} stroke={OUT} strokeWidth=".5" />
          </>
        )}
        <polygon points="-4,-34 -9,-34 -7,-27 -1.5,-24" fill="#384260" opacity=".9" />
        <polygon points="4,-34 9,-34 7,-27 1.5,-24" fill="#2a3249" opacity=".9" />
        <polygon points="2,-34 9,-34 8.5,-14 3,-14" fill="#000" opacity=".2" />
        <rect x="-6" y="-17.5" width="4" height="1.5" fill="#fff" opacity=".18" />
        {/* arms and hands */}
        <rect x="-12.5" y="-33" width="4" height="15" rx="1.5" fill="url(#fl-g-suitside)" {...o} />
        <rect x="8.5" y="-33" width="4" height="15" rx="1.5" fill="url(#fl-g-suitside)" {...o} />
        <rect x="-12.5" y="-18.5" width="4" height="3.5" rx="1.2" fill={s.skin} {...o} />
        <rect x="8.5" y="-18.5" width="4" height="3.5" rx="1.2" fill={s.skin} {...o} />
        {/* neck and head, shaded on the right */}
        <rect x="-2" y="-37" width="4" height="4" fill={s.skin} />
        <rect x="0.5" y="-37" width="1.5" height="4" fill="#000" opacity=".2" />
        <rect x="-8.5" y="-44" width="2" height="4" rx="1" fill={s.skin} {...o} />
        <rect x="6.5" y="-44" width="2" height="4" rx="1" fill={s.skin} {...o} />
        <rect x="-7" y="-50" width="14" height="14" rx="3.5" fill={s.skin} {...o} />
        <rect x="2.5" y="-49" width="4" height="12" rx="2" fill="#000" opacity=".14" />
        <rect x="-5.5" y="-41" width="2" height="1.2" rx=".6" fill="#ff8a8a" opacity=".35" />
        {/* hair, with a highlight */}
        {fem ? (
          <>
            <rect x="-9.5" y="-46" width="4" height="14" rx="2" fill={s.hair} {...o} />
            <rect x="5.5" y="-46" width="4" height="14" rx="2" fill={s.hair} {...o} />
            <rect x="-8.5" y="-53" width="17" height="7" rx="3.5" fill={s.hair} {...o} />
            <polygon points="-7.5,-47 1,-47 -2,-44 -7.5,-43" fill={s.hair} />
            <rect x="-5" y="-52" width="7" height="1.6" rx=".8" fill="#fff" opacity=".35" />
            <circle cx="-7.5" cy="-38.5" r="1" fill="#f3d27a" />
            <circle cx="7.5" cy="-38.5" r="1" fill="#f3d27a" />
          </>
        ) : (
          <>
            <rect x="-8" y="-53" width="16" height="6" rx="2.5" fill={s.hair} {...o} />
            <rect x="-8" y="-49" width="2.5" height="5" fill={s.hair} />
            <rect x="5.5" y="-49" width="2.5" height="3.5" fill={s.hair} />
            <rect x="-4.5" y="-52" width="6" height="1.5" rx=".7" fill="#fff" opacity=".3" />
          </>
        )}
        {/* face */}
        {away ? (
          <>
            <rect x="-4.5" y="-43" width="3" height=".9" fill="#1a1a1a" />
            <rect x="1.5" y="-43" width="3" height=".9" fill="#1a1a1a" />
          </>
        ) : (
          <>
            <rect x="-5" y="-45.5" width="3" height=".9" fill={s.hair} />
            <rect x="2" y="-45.5" width="3" height=".9" fill={s.hair} />
            <rect x="-4.6" y="-43.6" width="2.6" height="2.2" rx=".6" fill="#fff" />
            <rect x="2" y="-43.6" width="2.6" height="2.2" rx=".6" fill="#fff" />
            <rect x="-3.6" y="-43.3" width="1.4" height="1.8" fill="#14161c" />
            <rect x="3" y="-43.3" width="1.4" height="1.8" fill="#14161c" />
            {fem && <rect x="-4.8" y="-44" width="3" height=".6" fill="#14161c" />}
            {fem && <rect x="1.8" y="-44" width="3" height=".6" fill="#14161c" />}
          </>
        )}
        <rect x="-.5" y="-41.5" width="1.2" height="2" fill="#000" opacity=".18" />
        {active ? <rect x="-2" y="-38.6" width="4" height="1.8" rx=".8" fill="#7a2a2a" className="fl-mouth" /> : <rect x="-1.8" y="-38.3" width="3.6" height=".8" fill={fem ? "#b5485a" : "#6b3a32"} />}
        {/* a headset on whoever is talking */}
        {active && (
          <>
            <path d="M-8.5,-44 Q0,-58 8.5,-44" fill="none" stroke="#14161c" strokeWidth="1.8" />
            <rect x="-10" y="-45" width="3" height="4.5" rx="1" fill="#14161c" />
            <path d="M-8.5,-41 Q-7,-37 -3,-37.5" fill="none" stroke="#14161c" strokeWidth=".9" />
          </>
        )}
      </g>
      {away && <text x="11" y="-54" className="fl-zzz">z z</text>}
    </g>
  );
}

function Bubble({ line, faded }: { line: Line; faded?: boolean }) {
  const s = SEATS[line.from];
  const f = feet(s);
  const W = 236;
  const x = Math.max(82, Math.min(878 - W, f.x - W / 2));
  const text = line.kind === "work" ? `⚙ ${clip(line.text, 70)}` : line.kind === "warn" ? `⚠ ${clip(line.text, 80)}` : clip(line.text, line.kind === "say" ? 150 : 110);
  return (
    <foreignObject x={x} y={f.y - 60 - 96} width={W} height={96} className={`fl-bubble-fo ${faded ? "faded" : ""}`}>
      <div className="fl-bubble-box">
        <div className={`fl-bubble ${line.kind}`} style={{ borderColor: s.shirt }}>
          {line.to && line.kind === "hand" ? <b>@{SEATS[line.to].label} </b> : null}
          {text}
        </div>
      </div>
    </foreignObject>
  );
}

function Plant({ p }: { p: { x: number; y: number } }) {
  // a tall potted fiddle-leaf fig: a shaded planter, a trunk and layered leaves with highlights
  const LEAVES: Array<[number, number, number, number, string]> = [
    [-11, -38, 9, -35, "#1f7a45"], [11, -42, 9, 35, "#1f7a45"], [-8, -52, 8, -20, "#2a9455"], [9, -56, 8, 25, "#2a9455"],
    [-12, -64, 8, -40, "#2f9e5c"], [10, -70, 8, 40, "#36ad66"], [-4, -76, 8, -10, "#3fbd70"], [3, -84, 7, 15, "#4acb7b"], [-9, -46, 7, -55, "#257f4a"],
  ];
  return (
    <g transform={`translate(${p.x},${p.y})`} className="fl-decor">
      <ellipse cx="0" cy="1" rx="17" ry="6" fill="url(#fl-r-shadow)" />
      {/* planter */}
      <path d="M-11,-20 L11,-20 L9,0 Q0,3 -9,0 Z" fill="url(#fl-g-pot)" stroke={OUT} strokeWidth="1" />
      <ellipse cx="0" cy="-20" rx="11" ry="3.5" fill="#3b4150" stroke={OUT} strokeWidth="1" />
      <ellipse cx="0" cy="-19.6" rx="9" ry="2.6" fill="#2b2118" />
      <rect x="-8" y="-17" width="2" height="15" fill="#fff" opacity=".12" />
      {/* trunk */}
      <path d="M0,-20 C-1,-40 2,-60 0,-82" fill="none" stroke="#5a3d26" strokeWidth="2.4" />
      <path d="M0,-44 C-4,-48 -7,-52 -9,-56" fill="none" stroke="#5a3d26" strokeWidth="1.4" />
      <path d="M0,-58 C4,-62 6,-66 8,-70" fill="none" stroke="#5a3d26" strokeWidth="1.4" />
      {/* leaves */}
      {LEAVES.map(([x, y, r, rot, c], n) => (
        <g key={n} transform={`translate(${x},${y}) rotate(${rot})`}>
          <ellipse rx={r * 0.62} ry={r} fill={c} stroke={OUT} strokeWidth=".9" />
          <line x1="0" y1={-r + 1.5} x2="0" y2={r - 1.5} stroke="#0f4a28" strokeWidth=".7" />
          <ellipse cx={-r * 0.22} cy={-r * 0.3} rx={r * 0.16} ry={r * 0.42} fill="#fff" opacity=".18" />
        </g>
      ))}
    </g>
  );
}
