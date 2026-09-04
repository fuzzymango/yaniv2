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
  announceEnterAt,
  announceLeaveAt,
} from "../timing.ts";

/**
 * The word each call is announced as, and **upper case here rather than in the stylesheet**:
 * the banner says exactly `YANIV` or `ASSAF` and nothing else, so what a text transform makes
 * of it is not the place that decision should live.
 */
const SAID: Record<PlacedBanner["call"], string> = {
  yaniv: "YANIV",
  assaf: "ASSAF",
};

export function CallAnnouncement({ banner }: { banner: PlacedBanner }) {
  /*
   * When this banner arrives, and when every banner leaves — asked of `timing.ts`, which is
   * where the arithmetic of the sequence lives and where a test can reach it. The entrance
   * is staggered by the beat and the exit is not staggered at all, being measured from the
   * *last* entrance, which is why `count` is handed down beside `index`.
   */
  const enterAt = announceEnterAt(banner.index);
  const leaveAt = announceLeaveAt(banner.count);

  return (
    <span
      className={`announce announce--${banner.call}`}
      /*
       * Hidden from a screen reader, deliberately. The line above the felt already announces
       * the round as news, in a sentence that names both players — which is the better
       * telling of it — and a live region here would say `YANIV` over the top of it, twice on
       * an Assafed round. The banner is the *visual* half of one fact, not a second fact.
       */
      aria-hidden="true"
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
