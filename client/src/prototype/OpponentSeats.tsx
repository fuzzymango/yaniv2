/**
 * [PROTOTYPE — issue #56] Three structurally different takes on "seat every opponent
 * around the felt, fanned, facing the middle." Throwaway: pick one, fold the winner into
 * `Table.tsx`/`RoundEnd.tsx` for real, delete this file and the other two.
 *
 * All three share `seatZones` (the one thing the spec fixes) and a `SeatEntry` per
 * opponent; they disagree about geometry, card style and where the label sits.
 */

import type { ReactNode } from "react";
import { PlayingCard } from "../PlayingCard.tsx";
import { seatZones, type Zone } from "../seating.ts";
import { fanAngles, ZONE_ROTATION } from "./fan.ts";
import type { SeatEntry } from "./seatEntry.ts";

interface SeatsProps {
  opponents: readonly SeatEntry[];
  /** The felt itself (deck + discard), rendered in the middle, unchanged by variant. */
  children: ReactNode;
}

function SeatLabel({ seat, dense }: { seat: SeatEntry; dense?: boolean }) {
  return (
    <div className={`proto-label ${seat.isTurn ? "proto-label--turn" : ""} ${dense ? "proto-label--dense" : ""}`}>
      <span className="proto-label__name">{seat.name}</span>
      <span className="proto-label__score">{seat.score}pts</span>
      {!seat.cards && <span className="proto-label__count">{seat.cardCount}</span>}
      {seat.marks?.map((m) => (
        <span className="seat__mark" key={m}>
          {m}
        </span>
      ))}
      {seat.delta !== undefined && (
        <span className="proto-label__delta">{seat.delta > 0 ? `+${seat.delta}` : seat.delta}</span>
      )}
      {seat.handValue !== undefined && <span className="proto-label__value">{seat.handValue} in hand</span>}
    </div>
  );
}

/* ---------- Variant A — "Felt oval": arced fans, tight to the edge ---------- */

function ArcFan({ seat, cardScale }: { seat: SeatEntry; cardScale: number }) {
  const n = seat.cards?.length ?? seat.cardCount;
  const angles = fanAngles(n, 70);
  const radius = 34 * cardScale;
  const cards = seat.cards;
  return (
    <div className="proto-fan proto-fan--arc" style={{ ["--proto-scale" as string]: cardScale }}>
      {angles.map((deg, i) => {
        const card = cards?.[i] ?? null;
        return (
          <div
            key={i}
            className="proto-fan__card"
            style={{ transform: `rotate(${deg}deg) translateY(-${radius}px)` }}
          >
            {card ? <PlayingCard card={card} /> : <span className="card card--back" />}
          </div>
        );
      })}
    </div>
  );
}

function ZoneA({ zone, seats }: { zone: Zone; seats: SeatEntry[] }) {
  return (
    <div className={`proto-zone proto-zone--${zone} proto-zone--a`}>
      {seats.map((seat) => (
        <div className="proto-seat" style={{ transform: `rotate(${ZONE_ROTATION[zone]}deg)` }} key={seat.id}>
          <ArcFan seat={seat} cardScale={0.7} />
          <SeatLabel seat={seat} />
        </div>
      ))}
    </div>
  );
}

export function SeatsA({ opponents, children }: SeatsProps) {
  const zones = seatZones(opponents);
  return (
    <div className="proto-table proto-table--a">
      <ZoneA zone="left" seats={zones.left} />
      <ZoneA zone="top" seats={zones.top} />
      <ZoneA zone="right" seats={zones.right} />
      <div className="felt proto-felt-slot">{children}</div>
    </div>
  );
}

/* ---------- Variant B — "Minimal corners": a straight riffled stack, whole-fan rotation only ---------- */

function RiffleStack({ seat }: { seat: SeatEntry }) {
  const n = seat.cards?.length ?? seat.cardCount;
  const cards = seat.cards;
  return (
    <div className="proto-fan proto-fan--riffle">
      {Array.from({ length: n }, (_, i) => {
        const card = cards?.[i] ?? null;
        return (
          <div key={i} className="proto-fan__card" style={{ transform: `translateX(${i * 6}px)` }}>
            {card ? <PlayingCard card={card} /> : <span className="card card--back" />}
          </div>
        );
      })}
    </div>
  );
}

function ZoneB({ zone, seats }: { zone: Zone; seats: SeatEntry[] }) {
  return (
    <div className={`proto-zone proto-zone--${zone} proto-zone--b`}>
      {seats.map((seat) => (
        <div className="proto-seat proto-seat--b" key={seat.id}>
          <div className="proto-avatar">{seat.name.slice(0, 1).toUpperCase()}</div>
          <div style={{ transform: `rotate(${ZONE_ROTATION[zone]}deg)` }}>
            <RiffleStack seat={seat} />
          </div>
          <SeatLabel seat={seat} dense />
        </div>
      ))}
    </div>
  );
}

export function SeatsB({ opponents, children }: SeatsProps) {
  const zones = seatZones(opponents);
  return (
    <div className="proto-table proto-table--b">
      <ZoneB zone="left" seats={zones.left} />
      <ZoneB zone="top" seats={zones.top} />
      <ZoneB zone="right" seats={zones.right} />
      <div className="felt proto-felt-slot">{children}</div>
    </div>
  );
}

/* ---------- Variant C — "Compact stacked": small dense arcs, badge labels, tight doubling ---------- */

function ZoneC({ zone, seats }: { zone: Zone; seats: SeatEntry[] }) {
  return (
    <div className={`proto-zone proto-zone--${zone} proto-zone--c`}>
      {seats.map((seat, i) => (
        <div
          className={`proto-seat proto-seat--c ${i > 0 ? "proto-seat--stacked" : ""}`}
          key={seat.id}
        >
          <div className="proto-seat__inner" style={{ transform: `rotate(${ZONE_ROTATION[zone]}deg)` }}>
            <ArcFan seat={seat} cardScale={0.5} />
          </div>
          <SeatLabel seat={seat} dense />
        </div>
      ))}
    </div>
  );
}

export function SeatsC({ opponents, children }: SeatsProps) {
  const zones = seatZones(opponents);
  return (
    <div className="proto-table proto-table--c">
      <ZoneC zone="left" seats={zones.left} />
      <ZoneC zone="top" seats={zones.top} />
      <ZoneC zone="right" seats={zones.right} />
      <div className="felt proto-felt-slot">{children}</div>
    </div>
  );
}
