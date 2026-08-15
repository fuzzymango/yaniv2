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
 *   1. every card on the screen is measured after each render, so the position a move
 *      started from is still on hand once the position it ended at has been drawn;
 *   2. a move arrives, and the cards it discarded are measured where they have landed;
 *   3. a ghost is drawn at each landing place, moved back to where that card was, and let
 *      go — while the real card underneath waits, its face hidden and its control live,
 *      for its ghost to arrive.
 *
 * Purely decorative, and that is a constraint rather than a description: nothing here locks
 * a control, delays an intent or holds up a position. A player who taps through a flight
 * plays their turn as though there were none, and the ghosts are dropped mid-air.
 *
 * This ticket flies the viewer's own discard and nothing else (issue #72) — an opponent's
 * discard and the card coming back the other way are the tickets after it, and both are
 * this same mechanism pointed at other boxes.
 */

import type { Card } from "@yaniv/shared";
import type { CSSProperties, RefObject } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { PlayingCard } from "./PlayingCard.tsx";
import type { Box } from "./flip.ts";
import { invert, transformOf } from "./flip.ts";
import type { CardFlight } from "./flight.ts";

/**
 * How long a card is in the air.
 *
 * A sibling of `pacing.ts`'s `PACE_MS` and deliberately not derived from it: how long a
 * card takes to cross the table and how long a position stays on screen are two different
 * questions, and tying them together would mean tuning one by changing the other. What the
 * two owe each other is only this — a flight has to be over with room to spare inside a
 * beat, or a chain of bot turns would replace a position while its own cards were still
 * arriving. At better than twice the margin, it is.
 *
 * Long enough to be seen and short enough that a player who already knows what they played
 * never waits on it. They never wait on it in any case: the turn is sent, acked and drawn
 * regardless of what is in the air.
 */
export const FLIGHT_MS = 300;

/**
 * A straight line, decelerating. The path is deliberately plain — no arc, no flip, no
 * secondary anything — so what a card does on the way says nothing the position does not.
 * The curve is only so it arrives rather than stops.
 */
const EASING = "ease-out";

/** One card in the air: which card, where it was, and where it is going. */
export interface Ghost {
  readonly card: Card;
  readonly from: Box;
  readonly to: Box;
}

/**
 * Whether the player has asked for less movement. Read at the moment a flight would start
 * rather than once at load, so a preference changed mid-match is honoured on the next move.
 *
 * The answer is a flight that does not happen at all, rather than a faster one: the cards
 * are already where they belong the instant the position arrives, which is exactly what the
 * table looked like before any of this existed. The rest of the client says the same thing
 * in CSS (`prefers-reduced-motion` in `styles.css`); a measured animation cannot be turned
 * off from a stylesheet, so this one is asked in code.
 */
const wantsStillness = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Every card currently on the screen, by id, boxed where it is drawn.
 *
 * The root it is given must hold the table and **not** the ghosts: a ghost is a copy of a
 * card and carries the same id, so a layer inside this root would answer for the card it
 * copies — with a box taken mid-flight, part way through a transform. `Table.tsx` draws the
 * layer as a sibling of the screen for that reason.
 */
function measure(root: HTMLElement | null): Map<string, Box> {
  const boxes = new Map<string, Box>();
  if (root === null) return boxes;
  for (const element of root.querySelectorAll<HTMLElement>("[data-card-id]")) {
    const id = element.dataset.cardId;
    if (id !== undefined) boxes.set(id, element.getBoundingClientRect());
  }
  return boxes;
}

/**
 * What is watchable about a move, once the screen is taken into account: a card that was
 * nowhere a moment ago, or has landed nowhere now, has no flight to draw and is dropped
 * rather than guessed at.
 */
const ghostsFor = (
  cards: readonly Card[],
  before: Map<string, Box>,
  after: Map<string, Box>,
): Ghost[] =>
  cards.flatMap((card) => {
    const from = before.get(card.id);
    const to = after.get(card.id);
    return from === undefined || to === undefined ? [] : [{ card, from, to }];
  });

export interface InFlight {
  /** The screen the cards are measured within — every `[data-card-id]` inside it. */
  readonly rootRef: RefObject<HTMLElement | null>;
  /**
   * The cards whose place should be left empty because they have not arrived yet. Drawing
   * both the card and its ghost would show the same card twice, one of them sitting still
   * at the end of the other's journey.
   *
   * A place, not a control: whatever encloses one of these cards keeps working throughout,
   * because a flight may not cost a player a move (`.landing .card` in `styles.css`).
   */
  readonly landing: ReadonlySet<string>;
  /** Handed straight to `<CardsInFlight>`, which is the only thing that can read them. */
  readonly ghosts: readonly Ghost[];
  /** Every ghost has arrived, or been dropped. */
  readonly settle: () => void;
}

/**
 * Watch a position arrive, and answer with whatever is in the air because of it.
 *
 * `flight` is the session's one-shot (see `SessionSnapshot.flight`), and it is consumed by
 * identity: the object is the event, so the same one arriving again — a re-render off the
 * snapshot already held — is the same flight and is not flown twice.
 *
 * A move by anybody but the viewer is consumed and dropped here: the boxes an opponent's
 * cards start from are their seat rather than a hand, which is the next ticket's problem
 * (issue #69) and not a reason for this one to fly the wrong card off the wrong edge.
 */
export function useCardFlight(flight: CardFlight | null, viewerId: string): InFlight {
  const rootRef = useRef<HTMLElement>(null);
  /** Where every card was at the last render — the "first" of FLIP. */
  const boxes = useRef<Map<string, Box>>(new Map());
  /** The flight already dealt with, whether it was flown or dropped. */
  const played = useRef<CardFlight | null>(null);
  const [ghosts, setGhosts] = useState<readonly Ghost[]>([]);

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
    if (flight.playerId !== viewerId) return;
    if (wantsStillness()) return;

    const flying = ghostsFor(flight.discarded, before, boxes.current);
    if (flying.length > 0) setGhosts(flying);
  });

  const settle = useCallback(() => setGhosts([]), []);

  return {
    rootRef,
    landing: new Set(ghosts.map((ghost) => ghost.card.id)),
    ghosts,
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
  ghosts,
  onSettled,
}: {
  ghosts: readonly Ghost[];
  onSettled: () => void;
}) {
  /**
   * The element each ghost is drawn as, by card id — the same name the ghosts are keyed by,
   * rather than a second identity by position in a list. Refs are attached during the
   * commit, so every ghost rendered below is in here before the effect runs.
   */
  const drawn = useRef(new Map<string, HTMLElement>());

  useLayoutEffect(() => {
    const animations = ghosts.flatMap((ghost) => {
      const element = drawn.current.get(ghost.card.id);
      if (element === undefined) return [];
      return [
        element.animate([{ transform: startOf(ghost) }, { transform: "none" }], {
          duration: FLIGHT_MS,
          easing: EASING,
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
  }, [ghosts, onSettled]);

  if (ghosts.length === 0) return null;

  return (
    <div className="flight" aria-hidden="true">
      {ghosts.map((ghost) => (
        <span
          className="flight__card"
          style={ghostStyle(ghost)}
          ref={(element) => {
            if (element === null) drawn.current.delete(ghost.card.id);
            else drawn.current.set(ghost.card.id, element);
          }}
          key={ghost.card.id}
        >
          <PlayingCard card={ghost.card} />
        </span>
      ))}
    </div>
  );
}
