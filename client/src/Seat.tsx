/**
 * An opponent, sitting somewhere round the felt: their cards, and a label saying who they
 * are.
 *
 * The three pieces are kept apart on purpose. `SeatZone` is a side of the table and knows
 * only how many seats it has been dealt; `Seat` is one player's place at it, cards above
 * and label below; `CardFan` is the hand held there. The round-end reveal is the same
 * three pieces with a different middle one — hands face up, read rather than gestured at
 * (issue #60) — so the outer two take whatever cards they are handed, and `OpponentSeat`
 * is the one composition here that is specific to live play.
 *
 * **The label never turns with the fan.** The cards are rotated to face the middle,
 * because that is what says whose side of the table they are on; a name rotated with them
 * would be read sideways or upside down by the only person ever looking at it. It sits
 * below the fan, in the space the fan's own footprint reserves, which is what keeps a card
 * tip from being drawn across it.
 *
 * Presentational, like `PlayingCard`: nothing here decides anything, and the cards are
 * face down because an opponent's hand is not on the wire in the first place (see
 * "Serialization is the security boundary" in CLAUDE.md) — not because this chose to hide
 * it.
 *
 * The classes are `table-seat` rather than `seat`, which the lobby's roster row already
 * has. Two screens, two meanings of the word, and the lobby's is the older one.
 */

import type { CSSProperties, ReactNode } from "react";
import type { OpponentView } from "@yaniv/shared";
import { FAN_RADIUS, ZONE_ROTATION, fanAngles, fanFootprint, fanOverhang } from "./fan.ts";
import type { Zone } from "./seating.ts";

/** One side of the felt, holding the seats `seatZones` dealt it, in turn order. */
export function SeatZone({ zone, children }: { zone: Zone; children: ReactNode }) {
  return <div className={`table-zone table-zone--${zone}`}>{children}</div>;
}

interface SeatProps {
  zone: Zone;
  name: string;
  /** Whether the table is waiting on this player — the whole seat says so, not one row of it. */
  isTurn?: boolean;
  /** What else the label says about them: their score, their count, what a round cost them. */
  detail: ReactNode;
  /** Their cards, however the screen using this draws them. */
  children: ReactNode;
}

export function Seat({ zone, name, isTurn = false, detail, children }: SeatProps) {
  return (
    <div className={`table-seat table-seat--${zone} ${isTurn ? "table-seat--turn" : ""}`}>
      {children}
      <p className="table-seat__label">
        <span className="table-seat__name">{name}</span>
        {detail}
      </p>
    </div>
  );
}

/**
 * A hand held face down, arced about its hinge and turned to face the felt.
 *
 * Every card is placed by a transform off that one hinge point, so the fan is a single
 * rigid assembly however many cards are in it, and the zone's rotation is added to each
 * card's own angle rather than applied to a wrapper around them — a wrapper would have to
 * be sized and centred a second time, and the two sizes would then be free to disagree.
 *
 * The element's own box is the footprint the fan actually occupies (`fanFootprint`), which
 * a transform otherwise costs nothing in layout, and it is pushed out past its edge of the
 * screen by exactly `fanOverhang`. What is left on screen is the third of the fan nearest
 * the felt.
 */
export function CardFan({ zone, count }: { zone: Zone; count: number }) {
  const box = fanFootprint(count, zone);
  const overhang = fanOverhang(count);
  /** Card widths into a length, so the fan scales with the cards in it and nothing else. */
  const cards = (n: number) => `calc(var(--card-w) * ${n})`;

  /*
    The push off the edge is a margin rather than a transform: a transform costs no layout
    space, so it would leave the label sitting under where the fan used to be, half a fan
    away from the cards it names. A margin moves the two together.
  */
  const style: CSSProperties = {
    width: cards(box.width),
    height: cards(box.height),
    marginLeft: zone === "left" ? cards(-overhang) : undefined,
    marginRight: zone === "right" ? cards(-overhang) : undefined,
    marginTop: zone === "top" ? cards(-overhang) : undefined,
  };

  return (
    // Decorative: what these cards say is how many there are, and the label below says
    // that in words. A card back is not a card, so there is nothing here to read out.
    <div className={`table-seat__fan table-seat__fan--${zone}`} style={style} aria-hidden="true">
      {fanAngles(count).map((angle, i) => (
        <span
          className="card card--back table-seat__card"
          key={i}
          style={{
            // Turned by the zone and its own place in the arc, then pushed out to the
            // radius the footprint was measured with — one hinge, one distance.
            transform: `rotate(${ZONE_ROTATION[zone] + angle}deg) translateY(${cards(-FAN_RADIUS)})`,
          }}
        />
      ))}
    </div>
  );
}

/**
 * A seat during live play: one face-down card per card actually in that player's hand, and
 * a label saying who is holding them, how many there are and what they have scored.
 *
 * The count is in words as well as in cards because most of the fan is off the edge of the
 * screen by design — the fan says *a hand*, and exactly how big it is stays a number worth
 * reading rather than counting, which is what the text row this replaces always said.
 */
export function OpponentSeat({
  zone,
  opponent,
  isTurn,
}: {
  zone: Zone;
  opponent: OpponentView;
  isTurn: boolean;
}) {
  return (
    <Seat
      zone={zone}
      name={opponent.name}
      isTurn={isTurn}
      detail={
        <>
          <span className="player__cards">{opponent.handSize} cards</span>
          <span className="player__score">{opponent.score} pts</span>
        </>
      }
    >
      <CardFan zone={zone} count={opponent.handSize} />
    </Seat>
  );
}
