/**
 * An opponent, sitting somewhere round the felt: their cards, and a label saying who they
 * are.
 *
 * **Five exported components in one file, and the invariant is one box per seat.** The rule
 * elsewhere in this client is one exported component per file (CLAUDE.md, `client/src/`);
 * these five are the documented exception, because a seat's size is one fact and splitting
 * them would make it several. `CardFan` and `CascadeReveal` are two shapes of the *same* box
 * and take it from the same `seatFootprint` call, which is what lets a round being scored
 * swap one for the other and move nothing around them — a seat that resized at the reveal is
 * exactly what issue #78 fixed. `SeatZone` and `Seat` are the frame that box is measured and
 * placed against, and `OpponentSeat` the composition that puts a live hand in it; in another
 * file each would be reading that same size back out of this one.
 *
 * The three pieces are kept apart on purpose. `SeatZone` is a side of the table and knows
 * only how many seats it has been dealt; `Seat` is one player's place at it, cards above
 * and label below; the hand held there is `CardFan` during play and `CascadeReveal` once
 * the round is scored — face up, read rather than gestured at (issue #60). The outer two
 * take whatever cards they are handed, and `OpponentSeat` is the one composition here
 * specific to live play.
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
 * it. The one element drawn to be measured rather than looked at is the fan's own flight box
 * (`seatBox`, issue #74): a hand nobody can see has no card in it to fly to or from, so the
 * seat stands in for the lot, and even that is a place the layout already puts a card at.
 *
 * The classes are `table-seat` rather than `seat`, which the lobby's roster row already
 * has. Two screens, two meanings of the word, and the lobby's is the older one.
 */

import type { CSSProperties, ReactNode } from "react";
import type { Card, OpponentView } from "@yaniv/shared";
import {
  FAN_RADIUS,
  ZONE_CASCADE,
  ZONE_ROTATION,
  cascadeFootprint,
  cascadeOffset,
  fanAngles,
  fanOverhang,
  seatFootprint,
} from "../fan.ts";
import { PlayingCard } from "../shared/PlayingCard.tsx";
import { seatBox } from "../ghosts.ts";
import type { Zone } from "../seating.ts";

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
 * A distance in card widths written as a CSS length — the unit every measurement in
 * `fan.ts` comes back in, and the one both shapes of hand are placed and sized by.
 */
const cardWidths = (n: number) => `calc(var(--card-w) * ${n})`;

/**
 * The push off the seat's own edge of the screen, as the margin that does it.
 *
 * A margin rather than a transform: a transform costs no layout space, so it would leave
 * the label sitting under where the cards used to be, half a hand away from what it names.
 * A margin moves the two together — and, applied to the seat's reserved box rather than to
 * the shape inside it, it is the same distance whichever shape that is (`seatFootprint`).
 */
const overhangStyle = (zone: Zone, count: number): CSSProperties => {
  const overhang = cardWidths(-fanOverhang(count));
  return {
    marginLeft: zone === "left" ? overhang : undefined,
    marginRight: zone === "right" ? overhang : undefined,
    marginTop: zone === "top" ? overhang : undefined,
  };
};

/** The box a seat reserves for its hand, whichever shape is currently in it. */
const handSlot = (zone: Zone, count: number): CSSProperties => {
  const box = seatFootprint(count, zone);
  return {
    width: cardWidths(box.width),
    height: cardWidths(box.height),
    ...overhangStyle(zone, count),
  };
};

/**
 * A hand held face down, arced about its hinge and turned to face the felt.
 *
 * Every card is placed by a transform off that one hinge point, so the fan is a single
 * rigid assembly however many cards are in it, and the zone's rotation is added to each
 * card's own angle rather than applied to a wrapper around them — a wrapper would have to
 * be sized and centred a second time, and the two sizes would then be free to disagree.
 *
 * The element's own box is the one the seat reserves for a hand of this size in either of
 * its two shapes (`seatFootprint`), which a transform otherwise costs nothing in layout, and
 * it is pushed out past its edge of the screen by exactly `fanOverhang`. What is left on
 * screen is most of the fan — the part nearest the felt. The box is the reveal's as well as
 * the arc's so that a round being scored changes what is in the seat and never its size.
 *
 * `flightBox` is the name this hand answers to when a card is flying to or from it
 * (`seatBox` in `ghosts.ts`): one box for the whole hand, since none of the cards in it is
 * on the wire to have a box of its own.
 */
export function CardFan({
  zone,
  count,
  flightBox,
}: {
  zone: Zone;
  count: number;
  flightBox: string;
}) {
  return (
    // Decorative: what these cards say is how many there are, and the label below says
    // that in words. A card back is not a card, so there is nothing here to read out.
    <div
      className={`table-seat__fan table-seat__fan--${zone}`}
      style={handSlot(zone, count)}
      aria-hidden="true"
    >
      {/*
        Where a card flies to and from at this seat, and the one element here that is drawn
        for something other than being looked at: a hand held here is a count and a fan of
        backs, so no card in it can be measured by name (`seatBox`, `CardsInFlight.tsx`).

        It is the middle card of the arc, drawn exactly as the rest are, with the box that
        gets measured turned back upright *inside* it. Two elements rather than one because
        the turning back has to happen about the card's centre while the fan's own turn
        happens about its hinge, and an element has one `transform-origin` — so the inner box
        comes back level, on the same centre, and `getBoundingClientRect` answers with a
        card-shaped box rather than the bounding box of a rotated card, which is wider than
        the card at every angle but a right one. A ghost lands at the size it flew at, and
        the CSS has done all of the trigonometry: nothing here knows an angle's sine.
      */}
      <span
        className="card table-seat__card table-seat__box"
        style={{
          transform: `rotate(${ZONE_ROTATION[zone]}deg) translateY(${cardWidths(-FAN_RADIUS)})`,
        }}
      >
        <span
          className="table-seat__box-level"
          data-flight-box={flightBox}
          style={{ transform: `rotate(${-ZONE_ROTATION[zone]}deg)` }}
        />
      </span>
      {fanAngles(count).map((angle, i) => (
        <span
          className="card card--back table-seat__card"
          key={i}
          style={{
            // Turned by the zone and its own place in the arc, then pushed out to the
            // radius the footprint was measured with — one hinge, one distance.
            transform: `rotate(${ZONE_ROTATION[zone] + angle}deg) translateY(${cardWidths(-FAN_RADIUS)})`,
          }}
        />
      ))}
    </div>
  );
}

/**
 * A hand revealed at the end of a round: every card face up, stepped along one axis so
 * each one still shows its rank and suit under the next.
 *
 * A cascade rather than the arc the same seat held during play, because these cards are
 * *read* — an arc overlaps faces at an angle, which is exactly what makes checking a
 * Yaniv call against five hands hard (issue #56's variant D verdict, issue #60). Nothing
 * is rotated for the same reason: a zone's rotation says whose side of the table a hand is
 * on, and it says it by making the cards unreadable, which is a fair trade for a fan of
 * backs and no trade at all for a hand somebody has to add up. Which side of the table a
 * seat is on is said by where it sits and by the axis it runs along (`ZONE_CASCADE`).
 *
 * Built the way `CardFan` is: an element whose own box is the footprint the cards occupy
 * (`cascadeFootprint`), with each card placed on it by a transform off the same offsets
 * the box was measured from — so the label below cannot be drawn over, whatever the hand.
 *
 * That box sits inside the seat's own reserved one, which is the arc's as well (issue #78):
 * the seat is the same size in both shapes, so a round being scored swaps what is in it
 * without moving anything around it. Inside that box the cascade hugs the *felt* end — the
 * seat still hangs off its edge of the screen by `fanOverhang`, which is right for a fan of
 * backs and would take a bite out of a hand somebody has to read.
 */
export function CascadeReveal({ cards, zone }: { cards: readonly Card[]; zone: Zone }) {
  const axis = ZONE_CASCADE[zone];
  const box = cascadeFootprint(cards.length, axis);
  /* One place the axis becomes a direction, rather than the same fork in two transforms. */
  const along = axis === "vertical" ? "translateY" : "translateX";

  return (
    <div
      className={`table-seat__reveal table-seat__reveal--${zone}`}
      style={handSlot(zone, cards.length)}
    >
      <div
        className={`cascade cascade--${axis}`}
        style={{ width: cardWidths(box.width), height: cardWidths(box.height) }}
      >
        {cards.map((card, i) => (
          <span
            className="cascade__card"
            key={card.id}
            style={{
              transform: `${along}(${cardWidths(cascadeOffset(i))})`,
              // Later cards over earlier ones, so the strip left showing of each is the one
              // its own index sits in — the edge the cascade advances away from.
              zIndex: i,
            }}
          >
            <PlayingCard card={card} />
          </span>
        ))}
      </div>
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
      <CardFan zone={zone} count={opponent.handSize} flightBox={seatBox(opponent.id)} />
    </Seat>
  );
}
