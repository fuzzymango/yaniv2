/**
 * The call, said loudly and briefly over the seat it belongs to: `YANIV` in the table's
 * yellow, `ASSAF` in its red (issue #156).
 *
 * **Position is what says who.** The banner is not centred on the felt and carries no name
 * and no number — it is drawn inside the box of the seat it is about, so a player learns who
 * called by where they look rather than by reading. That is the whole difference between
 * this and a larger copy of the line above the felt, and it is why the component is rendered
 * in two parents — an opponent's seat, and the viewer's own hand row — rather than once,
 * somewhere above them both.
 *
 * **Not a measured overlay.** DOM measurement in this client is contained to
 * `CardsInFlight.tsx`, which needs it because a card genuinely travels between two distant
 * boxes; a banner does not travel. It sits on one box that is already positioned and already
 * sized by the seat's own reserved footprint, so CSS can place it and no second file has to
 * learn to measure.
 *
 * **The sequence is CSS and there is no timer.** Two elements at fixed offsets with no
 * branch after the first frame is a declarative timeline, so it is written as keyframes, and
 * the second banner's delay comes off its index in the ordered tuple `announcement.ts`
 * produced. The decisive advantage is cancellation: a deal landing over the top of this
 * unmounts the elements and the animation goes with them. There is no timer to leak, and
 * none to fire against a table that has moved on.
 *
 * Presentational throughout, like `PlayingCard`: it decides nothing. Which seats get a
 * banner, in which order, is `announcement.ts`'s and is asserted there — this maps one
 * `PlacedBanner` onto a word, a colour and two delays, and holds no conditional of its own.
 * The durations come down from `timing.ts` as custom properties rather than being written
 * into the stylesheet, so the chain stays in the one place a test can assert it.
 */

import type { CSSProperties } from "react";
import type { PlacedBanner } from "../announcement.ts";
import {
  ANNOUNCE_ENTER_MS,
  ANNOUNCE_EXIT_MS,
  ANNOUNCE_LEAD_MS,
  ANNOUNCE_MS,
} from "../timing.ts";

/** The word each call is announced as. Upper case is the style; this is the vocabulary. */
const SAID: Record<PlacedBanner["call"], string> = {
  yaniv: "Yaniv",
  assaf: "Assaf",
};

export function CallAnnouncement({ banner }: { banner: PlacedBanner }) {
  /*
   * When this banner arrives, and when every banner leaves.
   *
   * The entrance is staggered by the beat, so the pair reads in the order the round
   * actually had — a call, then the answer to it. The exit is not staggered at all: it is
   * measured from the *last* entrance, so both fade together and a player sees the two
   * seats the round turned on side by side before either goes. Which is why `count` is
   * handed down with `index` — a banner cannot know when the pair leaves from its own place
   * in it alone.
   */
  const enterAt = banner.index * ANNOUNCE_LEAD_MS;
  const leaveAt = (banner.count - 1) * ANNOUNCE_LEAD_MS + ANNOUNCE_MS;

  return (
    <span
      className={`announce announce--${banner.call}`}
      /*
       * Announced to a screen reader as news rather than as part of the seat's label: the
       * table has just changed under somebody who cannot see it flash, and the line above
       * the felt says the same thing in a sentence a moment later.
       */
      role="status"
      style={
        {
          "--announce-enter": `${ANNOUNCE_ENTER_MS}ms`,
          "--announce-exit": `${ANNOUNCE_EXIT_MS}ms`,
          "--announce-in-delay": `${enterAt}ms`,
          "--announce-out-delay": `${leaveAt}ms`,
        } as CSSProperties
      }
    >
      {SAID[banner.call]}
    </span>
  );
}
