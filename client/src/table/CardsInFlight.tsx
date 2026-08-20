/**
 * The flight itself: the cards of a move, drawn crossing the table on their way to where
 * the position already shows them.
 *
 * The imperative half of the card flight (issue #69). `flight.ts` decides *whether* there
 * is a move to watch and what is in it; this decides where on the screen it happens, and it
 * is the one place in this client that measures a rendered element. Everything it needs to
 * know about layout it reads off the screen — see `flip.ts` for why measuring beats
 * repeating the geometry the CSS has already worked out.
 *
 * The shape is FLIP, and the order matters:
 *
 *   1. every card on the screen is measured after each render — and the deck with them,
 *      being where a drawn card comes from and the one box that is not a card's — so the
 *      position a move started from is still on hand once the position it ended at has
 *      been drawn;
 *   2. a move arrives, and the cards it moved are measured where they have landed;
 *   3. a ghost is drawn at each landing place, moved back to where that card was, and let
 *      go — while the real card underneath waits, its face hidden and its control live,
 *      for its ghost to arrive.
 *
 * *Which* cards those are, and which way up each flies, is asked of `ghosts.ts`: this file
 * measures, animates and decides nothing else.
 *
 * Purely decorative, and that is a constraint rather than a description: nothing here locks
 * a control, delays an intent or holds up a position. A player who taps through a flight
 * plays their turn as though there were none, and the ghosts are dropped mid-air.
 *
 * Every move at the table flies, whoever took it (issues #72, #73, #74): the viewer's own
 * between their hand and the felt, everybody else's between their seat and it. Which boxes
 * that means is `ghosts.ts`'s answer, and the measuring below does not know the difference.
 *
 * *How* it flies is the one thing decided here that is not a measurement (issue #95): a
 * slapdown crosses faster, on a sharper curve, lands with a pop and jolts the table, and a
 * turn does none of those. The kind is carried alongside the ghosts rather than asked of each
 * one, because it is a fact about the move and not about a card in it.
 */

import type { CSSProperties, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PlayingCard } from "../shared/PlayingCard.tsx";
import type { Box } from "../flip.ts";
import { invert, transformOf } from "../flip.ts";
import type { CardFlight } from "../flight.ts";
import type { Ghost, Landing } from "../ghosts.ts";
import { ghostsFor } from "../ghosts.ts";
import { FLIGHT_MS, SHAKE_MS, SLAP_MS } from "../timing.ts";

/**
 * A straight line, decelerating. The path is deliberately plain — no arc, no flip, no
 * secondary anything — so what a card does on the way says nothing the position does not.
 * The curve is only so it arrives rather than stops.
 */
const EASING = "ease-out";

/**
 * The same line, accelerating instead: a slapdown leaves the hand rather than being placed,
 * so it arrives at its fastest rather than settling onto the pile. The mirror of `EASING`
 * about the middle, which is what makes the pair read as two ways of doing one thing.
 */
const SLAP_EASING = "cubic-bezier(0.55, 0, 1, 0.45)";

/**
 * The pop a slapped card lands on: a twelfth over size, about its own centre, before it
 * settles onto the pile at the size everything else there is.
 *
 * Written as a translate and a scale rather than a `transform-origin` of its own, because the
 * corner this element scales about is the one the whole flight is arithmetic against
 * (`flip.ts`) — moving it for one keyframe would move the journey with it. Half the excess
 * back along each axis, as a proportion of the card, holds the centre still.
 */
const POP = "translate(-6%, -6%) scale(1.12)";

/** How much of a slapdown is the journey, the rest of it being the pop at the end. */
const POP_AT = 0.7;

/**
 * Whether the player has asked for less movement. Read at the moment a flight would start
 * rather than once at load, so a preference changed mid-match is honoured on the next move.
 *
 * The answer is a flight that does not happen at all, rather than a faster one: the cards
 * are already where they belong the instant the position arrives, which is exactly what the
 * table looked like before any of this existed. The rest of the client says the same thing
 * in CSS (`prefers-reduced-motion` in `styles.css`); a measured animation cannot be turned
 * off from a stylesheet, so this one is asked in code.
 *
 * One gate for all three parts of a slapdown: the flight, the pop it lands on and the jolt
 * behind it. The pop is a keyframe of the flight and the jolt is triggered by its finishing,
 * so a flight that never starts takes both with it — the table is left exactly as
 * `lastDiscard` already shows it, which is a card sitting on the pile.
 */
const wantsStillness = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Everywhere on the screen a flight can begin or end, boxed where it is drawn: every card by
 * its own id, and the deck and each seat under their own names — the places in the
 * measurements that are not cards, standing in at whichever end of a journey the client was
 * never told a card id for (`DECK_BOX` and `seatBox` in `ghosts.ts`).
 *
 * The root it is given must hold the table and **not** the ghosts: a ghost is a copy of a
 * card and carries the same id, so a layer inside this root would answer for the card it
 * copies — with a box taken mid-flight, part way through a transform. `Table.tsx` draws the
 * layer as a sibling of the screen for that reason.
 */
function measure(root: HTMLElement | null): Map<string, Box> {
  const boxes = new Map<string, Box>();
  if (root === null) return boxes;
  for (const element of root.querySelectorAll<HTMLElement>("[data-card-id], [data-flight-box]")) {
    const id = element.dataset.cardId ?? element.dataset.flightBox;
    if (id !== undefined) boxes.set(id, element.getBoundingClientRect());
  }
  return boxes;
}

/**
 * What is in the air, and what kind of move put it there — one object, so the two cannot
 * disagree. A slapdown's ghost is drawn no differently from a turn's; it is flown
 * differently, and the difference is the whole of what the kind is read for here.
 */
export interface Airborne {
  readonly kind: CardFlight["kind"];
  readonly ghosts: readonly Ghost[];
}

export interface InFlight {
  /** The screen the boxes are measured within — every card inside it, and the deck. */
  readonly rootRef: RefObject<HTMLElement | null>;
  /**
   * The cards whose place should be left empty because they have not arrived yet, and which
   * place that is. Drawing both the card and its ghost would show the same card twice, one of
   * them sitting still at the end of the other's journey.
   *
   * By place and not by card, because a card can be in two at once: a slapdown inside a
   * flight puts the card still flying into the hand onto the pile, and where it has actually
   * got to is not a place waiting for it.
   *
   * A place, not a control: whatever encloses one of these cards keeps working throughout,
   * because a flight may not cost a player a move (`.landing .card` in `styles.css`).
   */
  readonly landing: ReadonlyMap<string, Landing>;
  /**
   * The cards in the air and the kind of move flying them, handed straight to
   * `<CardsInFlight>`, which is the only thing that can read either. Null is a still table.
   */
  readonly flying: Airborne | null;
  /**
   * Whether the table should be ringing from a slapdown just landed — worn by the screen as
   * a class for `SHAKE_MS` and taken off again (`.table--jolt` in `styles.css`).
   *
   * A boolean here and a keyframe there, rather than an animation run against the element:
   * the jolt moves the whole table, which is the one thing on this screen that is neither a
   * card nor measured, and the file that owns its layout should be the file that says how far
   * it moves.
   */
  readonly jolt: boolean;
  /** Every ghost has arrived, or been dropped. */
  readonly settle: () => void;
}

/**
 * Watch a position arrive, and answer with whatever is in the air because of it.
 *
 * `flight` is the session's one-shot (see `SessionSnapshot.flight`), and it is consumed by
 * identity: the object is the event, so the same one arriving again — a re-render off the
 * snapshot already held — is the same flight and is not flown twice. It is consumed whether
 * or not anything flies: a move nobody is shown is still a move that has been dealt with.
 */
export function useCardFlight(flight: CardFlight | null, viewerId: string): InFlight {
  const rootRef = useRef<HTMLElement>(null);
  /** Where every card was at the last render — the "first" of FLIP. */
  const boxes = useRef<Map<string, Box>>(new Map());
  /** The flight already dealt with, whether it was flown or dropped. */
  const played = useRef<CardFlight | null>(null);
  const [flying, setFlying] = useState<Airborne | null>(null);
  const [jolt, setJolt] = useState(false);

  /*
   * Deliberately without a dependency list: the measurement has to be taken after *every*
   * render, or a move that lands two renders after a card was last measured would fly from
   * a stale box. A layout effect rather than an effect, because both halves of the work
   * have to happen before the browser paints — the measuring, which a paint would not
   * disturb but a later one would, and the hiding of a landed card, which a paint in
   * between would show as a flicker of the card at its destination.
   */
  useLayoutEffect(() => {
    const before = boxes.current;
    boxes.current = measure(rootRef.current);

    if (flight === null || flight === played.current) return;
    played.current = flight;
    if (wantsStillness()) return;

    const ghosts = ghostsFor(flight, viewerId, before, boxes.current);
    if (ghosts.length > 0) setFlying({ kind: flight.kind, ghosts });
  });

  /*
   * The jolt takes itself off after `SHAKE_MS` — the same length the keyframe runs for, read
   * from the one place either of them gets it. Nothing waits on the timer, and a screen that
   * goes while it is pending clears it.
   */
  useEffect(() => {
    if (!jolt) return;
    const timer = window.setTimeout(() => setJolt(false), SHAKE_MS);
    return () => window.clearTimeout(timer);
  }, [jolt]);

  /*
   * The end of a flight, and — for a slapdown alone — the start of the jolt behind it. Here
   * rather than beside the animation because this is where the kind of the move is known, and
   * because a jolt that fired on anything else would make every discard an event.
   */
  const settle = useCallback(() => {
    setFlying(null);
    if (flying?.kind === "slapdown") setJolt(true);
  }, [flying]);

  return {
    rootRef,
    landing: new Map((flying?.ghosts ?? []).map((ghost) => [ghost.id, ghost.into])),
    flying,
    jolt,
    settle,
  };
}

/**
 * Where a ghost is drawn: its landing place, at the size it lands at.
 *
 * The card is placed where it is going and moved back, rather than placed where it came
 * from and moved forward, because only the destination is a box the layout will still
 * agree with when the animation ends. `--card-w` is the width the card was measured at, so
 * the ghost is the same size as the card underneath it by construction rather than by both
 * of them reading the same stylesheet rule.
 */
const ghostStyle = (ghost: Ghost): CSSProperties =>
  // Cast because `CSSProperties` has no room for a custom property, and `--card-w` is how a
  // card is sized everywhere in this client (`styles.css`) — the alternative is a second way
  // of sizing one, for the ghost alone.
  ({
    left: `${ghost.to.left}px`,
    top: `${ghost.to.top}px`,
    "--card-w": `${ghost.to.width}px`,
    // Set inline as well as animated, so the first frame is already at the start of the
    // journey rather than at its end.
    transform: startOf(ghost),
  }) as CSSProperties;

/** Where a ghost begins: its landing place, put back where the card came from. */
const startOf = ({ from, to }: Ghost): string => transformOf(invert(from, to));

/**
 * How one card is flown, by what kind of move is flying it.
 *
 * A turn is one keyframe to another over `FLIGHT_MS`, decelerating. A slapdown is the same
 * journey in `SLAP_MS` on the sharper curve, and then a beat of its own: the card overshoots
 * its size on arrival and settles, which is a second keyframe on the element already moving
 * rather than anything new to draw or measure. Each stretch carries its own easing, since the
 * curve the card *travelled* on is not the curve a pop settles on.
 */
const flightOf = (
  ghost: Ghost,
  kind: CardFlight["kind"],
): { keyframes: Keyframe[]; timing: KeyframeAnimationOptions } =>
  kind === "slapdown"
    ? {
        keyframes: [
          { transform: startOf(ghost), easing: SLAP_EASING },
          { transform: POP, offset: POP_AT, easing: EASING },
          { transform: "none" },
        ],
        timing: { duration: SLAP_MS },
      }
    : {
        keyframes: [{ transform: startOf(ghost) }, { transform: "none" }],
        timing: { duration: FLIGHT_MS, easing: EASING },
      };

/**
 * The cards in the air, over the whole screen and under nothing.
 *
 * Fixed to the viewport because that is the frame the boxes were measured in, and inert to
 * every tap because a card in flight is a picture of something that has already happened —
 * the real controls are underneath, live, and answering.
 *
 * Hidden from assistive technology outright: the position it illustrates has already been
 * announced by the table itself, and a card read out twice is worse than a card not seen
 * moving.
 */
export function CardsInFlight({
  flying,
  onSettled,
}: {
  flying: Airborne | null;
  onSettled: () => void;
}) {
  /**
   * The element each ghost is drawn as, by the name the ghost answers to — rather than a
   * second identity by position in a list. Refs are attached during the commit, so every
   * ghost rendered below is in here before the effect runs.
   */
  const drawn = useRef(new Map<string, HTMLElement>());

  useLayoutEffect(() => {
    if (flying === null) return;
    const animations = flying.ghosts.flatMap((ghost) => {
      const element = drawn.current.get(ghost.id);
      if (element === undefined) return [];
      const { keyframes, timing } = flightOf(ghost, flying.kind);
      return [
        element.animate(keyframes, {
          ...timing,
          // Held at the end rather than handed back to the inline transform below, which is
          // where the card *started*: the ghost is removed a render later, and without this
          // it would spend that frame back at the top of its journey.
          fill: "forwards",
        }),
      ];
    });
    if (animations.length === 0) return;

    // A cancelled animation rejects, which is what the cleanup below does to every flight
    // still in the air when the screen moves on — nothing left to settle, and nothing to
    // report either.
    Promise.all(animations.map((animation) => animation.finished)).then(onSettled, () => {});

    return () => {
      for (const animation of animations) animation.cancel();
    };
  }, [flying, onSettled]);

  if (flying === null) return null;

  return (
    <div className="flight" aria-hidden="true">
      {flying.ghosts.map((ghost) => (
        <span
          className="flight__card"
          style={ghostStyle(ghost)}
          ref={(element) => {
            if (element === null) drawn.current.delete(ghost.id);
            else drawn.current.set(ghost.id, element);
          }}
          key={ghost.id}
        >
          {/*
            A back rather than a face, for a card with no face to show — one off the deck,
            which turns over nowhere: where the drawer's own is going the hand is already
            showing it, and anybody else's it is never shown at all. Deliberately not a
            `PlayingCard` — that names the card in the markup, and a card being watched arrive
            face down has no business being findable by name on the way.
          */}
          {ghost.face === null ? (
            <span className="card card--back" />
          ) : (
            <PlayingCard card={ghost.face} />
          )}
        </span>
      ))}
    </div>
  );
}
