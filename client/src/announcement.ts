/**
 * Whether a call is worth announcing, and whose seats it belongs over.
 *
 * The pure half of the **call announcement** (issue #156), and `flight.ts`'s counterpart:
 * two positions in — the one on the screen and the one that has just arrived — and either
 * an ordered description of what to announce or nothing at all. It says who called and who
 * took the call off them, in the order those two things happened. It says nothing about
 * pixels, elements or timing; the layer that draws a banner asks this module what there is
 * to say and works the rest out for itself.
 *
 * It exists because a **Yaniv call is the one broadcast a flight has nothing to show for**:
 * it leaves both facts `flight.ts` is read from exactly where they were, so the loudest
 * moment in a round is the one moment nothing crosses the table. This is that move's
 * counterpart, and it takes the same shape for the same reason — an event decided once as a
 * position arrives, not a fact about the table that stands for as long as the position does.
 *
 * Total in the same way as its sibling: every pair of positions has an answer, and "nothing
 * to announce" is one of them.
 */

import type { PlayerGameView } from "@yaniv/shared";

/** The two things a round can turn on, and there are no others (docs/rules.md §6). */
export type Call = "yaniv" | "assaf";

/** One banner: the word, and the seat it goes over. Position is what says who. */
export interface Banner {
  readonly playerId: string;
  readonly call: Call;
}

/**
 * What there is to announce, **ordered — the call first, the Assaf second** — or null when
 * there is nothing.
 *
 * A union of two tuples rather than an array, on this codebase's habit of making a bad
 * state unrepresentable rather than guarding against it: an empty announcement and a third
 * banner are both impossible to construct, so "nothing to announce" has exactly one
 * spelling and a renderer has no length to check. The ordering is what lets each banner's
 * delay fall out of its index with no conditional anywhere near a component.
 */
export type Announcement = readonly [Banner] | readonly [Banner, Banner] | null;

/**
 * One banner with its place in the sequence — what a single seat's slot needs to know, and
 * the whole of it.
 *
 * `index` is the beat it arrives on and `count` is how many are arriving in all, which
 * together say when the pair leaves: everything fades together, so the last banner's
 * entrance is what the exit is measured from. Both are given here rather than derived in
 * the component, the component being the one place in this client nothing is asserted.
 */
export interface PlacedBanner {
  readonly call: Call;
  readonly index: number;
  readonly count: number;
}

/**
 * What the arriving position has to announce, or null.
 *
 * **The trigger is the number of scored rounds, and deliberately not "there is a round
 * result here".** The result is match-scoped and is left standing between rounds, so it
 * survives a deal, a disconnect, a departure and a seat resumed — and a match ended by a
 * departure reaches `gameEnd` carrying the *previous* round's result behind it, with nobody
 * having called anything. Any trigger read off that field announces on all of those. The
 * scorecard is sent whole in every phase and grows by exactly one row per scored round
 * (docs/adr/0017), so a row that was not there a moment ago *is* a round that was just
 * scored — and none of those republishing paths adds one.
 *
 * That is a coupling to the scorecard and it is accepted: if a row were ever written for
 * anything other than a scored round, this would announce for it silently. The other end of
 * the coupling is commented in `server/src/game.ts` where the row is appended.
 *
 * The row is also what the announcement is *read* from, rather than `roundResult` beside
 * it: the newest row is definitionally the round being revealed, and taking the key and the
 * content from one fact leaves no second fact to disagree with it.
 *
 * `shown` is null where there is no position to have arrived from — a page that has just
 * come up, or a seat being claimed back. Whatever round was last scored at that table is
 * one this viewer was not there for, and an announcement is an event rather than a record.
 *
 * The phase is not asked about at all, and that is the point: the round result is populated
 * at `roundEnd` **and** `gameEnd`, so a match-winning Yaniv never arrives as a `roundEnd`
 * and a trigger that named the phase would leave the most consequential call of a match as
 * the one call with no announcement.
 */
export function announcementFrom(
  shown: PlayerGameView | null,
  arriving: PlayerGameView,
): Announcement {
  if (shown === null) return null;
  if (arriving.scorecard.length <= shown.scorecard.length) return null;

  const round = arriving.scorecard[arriving.scorecard.length - 1];
  if (round === undefined) return null;

  const call: Banner = { playerId: round.callerId, call: "yaniv" };
  return round.assaferId === null
    ? [call]
    : [call, { playerId: round.assaferId, call: "assaf" }];
}

/**
 * The banner that goes over one seat, with its place in the sequence, or null where that
 * seat is not one the round turned on.
 *
 * Here rather than in the screen because it is the "one banner or two" question asked from
 * a single seat's point of view, and that is exactly the branch a component in this client
 * is not trusted with. Every seat on the table asks it, and at most two get an answer.
 */
export function bannerAt(announcement: Announcement, playerId: string): PlacedBanner | null {
  if (announcement === null) return null;
  const index = announcement.findIndex((banner) => banner.playerId === playerId);
  if (index === -1) return null;
  return { call: announcement[index]!.call, index, count: announcement.length };
}
