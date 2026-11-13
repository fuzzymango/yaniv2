/**
 * PROTOTYPE — throwaway (issue #279). Four variants of the milestone countdown, drawn on the
 * real `Table` at `roundEnd` off a fixture view — no server, no socket. Switch with
 * `?variant=A..D` (or `today` for the current grey chip), the bottom bar, or ← / →.
 *
 *   R  replay the round being scored        S  Yaniv ↔ Assafed (banner timing)
 *   M  reduced motion on/off                H  hide the bar
 *
 * The fixture (maxScore 140) puts every case the spec names on one table:
 *   You    20 + 30 = 50  → 0     milestone, the footer        (the caller, Assafed, in "assaf")
 *   Dana  100 + 50 = 150 → 100   milestone that saves         (no OUT, ever)
 *   Moshe 140 + 60 = 200 → 150   milestone and out            (OUT withheld until the count lands)
 *   Yossi 120 + 37 = 157         out, no milestone            (OUT at once, as today)
 *   Avi    35 + 0  = 35          the caller (or the Assafer)
 */

import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Card,
  OpponentView,
  PlayerGameView,
  PlayerRoundResultView,
  Rank,
  Suit,
} from "@yaniv/shared";
import { rankToValue } from "@yaniv/shared";
import type { Announcement } from "../announcement.ts";
import { announceEnterAt } from "../timing.ts";
import { Table } from "./Table.tsx";
import type { MilestonePrototype as Proto, VariantKey } from "./MilestoneCountdown.prototype.tsx";
import { MilestonePrototypeContext, VARIANTS } from "./MilestoneCountdown.prototype.tsx";
import "../styles.css";
import "./milestone-prototype.css";

type Scenario = "yaniv" | "assaf";
type Key = VariantKey | "today";
const KEYS: readonly Key[] = [...VARIANTS.map((v) => v.key), "today"];

const card = (rank: Rank, suit: Suit | null, n = 1): Card => ({
  id: suit === null ? `joker-${n}` : `${suit}-${rank}`,
  suit,
  rank,
  value: rankToValue(rank),
});

interface Row {
  id: string;
  name: string;
  before: number;
  hand: Card[];
  /** Penalty on top of the hand (an Assafed caller's 30), or 0. */
  extra: number;
  history: [number, number, number];
}

function fixture(scenario: Scenario): { view: PlayerGameView; announcement: Announcement } {
  const MAX = 140;
  const rows: Row[] = [
    {
      id: "p-you",
      name: "You",
      before: 20,
      hand:
        scenario === "assaf"
          ? [card("Joker", null, 1)]
          : [card("10", "spades"), card("10", "hearts"), card("5", "clubs"), card("5", "diamonds")],
      extra: scenario === "assaf" ? 30 : 0,
      history: [10, 15, 20],
    },
    {
      id: "p-avi",
      name: "Avi",
      before: 35,
      hand: scenario === "assaf" ? [card("Joker", null, 2)] : [card("A", "clubs"), card("2", "clubs")],
      extra: 0,
      history: [5, 20, 35],
    },
    {
      id: "p-yossi",
      name: "Yossi",
      before: 120,
      hand: [card("K", "spades"), card("Q", "spades"), card("J", "diamonds"), card("7", "hearts")],
      extra: 0,
      history: [40, 80, 120],
    },
    {
      id: "p-dana",
      name: "Dana",
      before: 100,
      hand: [
        card("K", "hearts"),
        card("Q", "hearts"),
        card("J", "hearts"),
        card("10", "diamonds"),
        card("10", "clubs"),
      ],
      extra: 0,
      history: [30, 70, 100],
    },
    {
      id: "p-moshe",
      name: "Moshe",
      before: 140,
      hand: [
        card("K", "clubs"),
        card("Q", "clubs"),
        card("J", "spades"),
        card("9", "spades"),
        card("9", "hearts"),
        card("8", "clubs"),
        card("4", "diamonds"),
      ],
      extra: 0,
      history: [45, 95, 140],
    },
  ];

  const callerId = scenario === "assaf" ? "p-you" : "p-avi";
  const assaferId = scenario === "assaf" ? "p-avi" : null;

  const results: PlayerRoundResultView[] = rows.map((row) => {
    const handValue = row.hand.reduce((sum, c) => sum + c.value, 0);
    const delta = row.id === (assaferId ?? callerId) ? 0 : handValue + row.extra;
    const landed = row.before + delta;
    const milestoneReduction = delta > 0 && landed % 50 === 0 ? 50 : 0;
    return {
      playerId: row.id,
      name: row.name,
      hand: row.hand,
      handValue,
      delta,
      milestoneReduction,
      scoreAfter: landed - milestoneReduction,
    };
  });
  const after = (id: string) => results.find((r) => r.playerId === id)!;
  const outIn = (id: string) => (after(id).scoreAfter > MAX ? 4 : null);

  const opponents: OpponentView[] = rows.slice(1).map((row) => ({
    id: row.id,
    name: row.name,
    score: after(row.id).scoreAfter,
    accountId: null,
    customYanivCall: null,
    customAssafCall: null,
    handSize: row.hand.length,
    spectating: false,
    outInRound: outIn(row.id),
    departed: false,
    connected: true,
  }));

  const view: PlayerGameView = {
    roomCode: "PROTO",
    phase: "roundEnd",
    roundNumber: 4,
    hostId: null,
    settings: { handSize: 7, yanivThreshold: 7, maxScore: MAX, botCount: 0 },
    you: {
      id: "p-you",
      name: "You",
      score: after("p-you").scoreAfter,
      accountId: null,
      customYanivCall: null,
      customAssafCall: null,
      outInRound: null,
      departed: false,
      connected: true,
      spectating: false,
      hand: rows[0]!.hand,
      slapdownEligible: false,
    },
    opponents,
    seating: rows.map((r) => r.id),
    turnOrder: rows.map((r) => r.id),
    currentTurnPlayerId: null,
    drawPileCount: 21,
    lastDiscard: [card("6", "spades")],
    buriedCount: 9,
    lastMove: null,
    lastSlapdown: null,
    moveHistory: [],
    roundResult: { roundNumber: 4, callerId, assaferId, winnerId: assaferId ?? callerId, players: results },
    scorecard: [
      ...[0, 1, 2].map((i) => ({
        roundNumber: i + 1,
        callerId: "p-avi",
        assaferId: null,
        players: rows.map((r) => ({ playerId: r.id, scoreAfter: r.history[i]!, milestoneReduction: 0 })),
      })),
      {
        roundNumber: 4,
        callerId,
        assaferId,
        players: results.map((r) => ({
          playerId: r.playerId,
          scoreAfter: r.scoreAfter,
          milestoneReduction: r.milestoneReduction,
        })),
      },
    ],
    winnerIds: null,
  };

  const announcement: Announcement =
    assaferId === null
      ? [{ playerId: callerId, call: "yaniv", text: "YANIV" }]
      : [
          { playerId: callerId, call: "yaniv", text: "YANIV" },
          { playerId: assaferId, call: "assaf", text: "ASSAF" },
        ];
  return { view, announcement };
}

const params = () => new URLSearchParams(window.location.search);
const prefersReduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function readKey(): Key {
  const v = params().get("variant");
  return KEYS.includes(v as Key) ? (v as Key) : "A";
}

function Prototype() {
  const [key, setKey] = useState<Key>(readKey);
  const [scenario, setScenario] = useState<Scenario>(() =>
    params().get("scenario") === "assaf" ? "assaf" : "yaniv",
  );
  const [reduced, setReduced] = useState(() =>
    params().has("reduced") ? params().get("reduced") === "1" : prefersReduced(),
  );
  const [countMs, setCountMs] = useState(() => Number(params().get("ms")) || 2000);
  const [epoch, setEpoch] = useState(() => performance.now());
  const [barHidden, setBarHidden] = useState(false);

  const replay = useCallback(() => setEpoch(performance.now()), []);

  // Every change is a fresh scoring of the round, and lands in the URL so it is shareable.
  useEffect(() => {
    const p = params();
    p.set("variant", key);
    p.set("scenario", scenario);
    p.set("reduced", reduced ? "1" : "0");
    p.set("ms", String(countMs));
    window.history.replaceState(null, "", `?${p}`);
    replay();
  }, [key, scenario, reduced, countMs, replay]);

  const cycle = useCallback(
    (step: number) => setKey((k) => KEYS[(KEYS.indexOf(k) + step + KEYS.length) % KEYS.length]!),
    [],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return;
      if (event.key === "ArrowLeft") cycle(-1);
      else if (event.key === "ArrowRight") cycle(1);
      else if (event.key === "r") replay();
      else if (event.key === "s") setScenario((s) => (s === "yaniv" ? "assaf" : "yaniv"));
      else if (event.key === "m") setReduced((r) => !r);
      else if (event.key === "h") setBarHidden((h) => !h);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycle, replay]);

  const { view, announcement } = fixture(scenario);
  // The count starts with the call: as the first banner (YANIV) arrives, not once they leave.
  const startAt = announceEnterAt(0);
  const variant = VARIANTS.find((v) => v.key === key) ?? null;
  const proto: Proto | null =
    variant === null ? null : { variant, reduced, epoch, startAt, countMs };

  return (
    <div className={reduced ? "msp-reduced" : ""}>
      <MilestonePrototypeContext.Provider value={proto}>
        <Table
          key={epoch}
          view={view}
          selection={[]}
          busy={false}
          flight={null}
          announcement={announcement}
          onToggleCard={() => {}}
          onCommitTurn={() => {}}
          onCallYaniv={() => {}}
          onNextRound={replay}
          onSlapDown={() => {}}
          onExit={() => {}}
        />
      </MilestonePrototypeContext.Provider>
      {barHidden ? (
        <button className="msp-bar msp-bar--tab" type="button" onClick={() => setBarHidden(false)}>
          prototype ▴
        </button>
      ) : (
        <div className="msp-bar" role="toolbar" aria-label="Prototype switcher">
          <div className="msp-bar__row">
            <button type="button" onClick={() => cycle(-1)} aria-label="Previous variant">
              ←
            </button>
            <span className="msp-bar__label" title={variant?.blurb}>
              <b>{key === "today" ? "Today" : key}</b> — {variant?.name ?? "the grey MILESTONE chip, no count"}
            </span>
            <button type="button" onClick={() => cycle(1)} aria-label="Next variant">
              →
            </button>
          </div>
          <div className="msp-bar__row msp-bar__row--controls">
            <button type="button" onClick={replay} title="Replay (R)">
              ↻ replay
            </button>
            <button
              type="button"
              title="Scenario (S): who called, and so when the banners have gone"
              onClick={() => setScenario((s) => (s === "yaniv" ? "assaf" : "yaniv"))}
            >
              {scenario === "yaniv" ? "Yaniv" : "Assafed"} @{(startAt / 1000).toFixed(2)}s
            </button>
            <button
              type="button"
              title="Reduced motion (M)"
              aria-pressed={reduced}
              onClick={() => setReduced((r) => !r)}
            >
              RM {reduced ? "on" : "off"}
            </button>
            <select
              value={countMs}
              onChange={(e) => setCountMs(Number(e.target.value))}
              aria-label="Count duration"
            >
              {[1500, 2000, 2500, 3000].map((ms) => (
                <option key={ms} value={ms}>
                  {ms / 1000}s
                </option>
              ))}
            </select>
            <Clock epoch={epoch} startAt={startAt} countMs={countMs} />
            <button type="button" onClick={() => setBarHidden(true)} aria-label="Hide the bar">
              ▾
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Where the sequence is, so a variant can be judged against the beat it lands on. */
function Clock({ epoch, startAt, countMs }: { epoch: number; startAt: number; countMs: number }) {
  const [e, setE] = useState(0);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      setE(performance.now() - epoch);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [epoch]);
  const stage = e < startAt ? "banners" : e < startAt + countMs ? "counting" : "landed";
  return (
    <span className="msp-bar__clock">
      {(e / 1000).toFixed(1)}s · {stage}
    </span>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Prototype />
  </StrictMode>,
);
