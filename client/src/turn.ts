/**
 * What a tap means, given what is on the table.
 *
 * The browser's counterpart to `server/scripts/cli/commands.ts`: pure and total, a
 * selection plus a tapped source in, a `TurnAction` or nothing out — and, for the Yaniv
 * call that replaces a turn rather than taking one, whether the hand permits it at all.
 * Nothing here throws and nothing here reaches a socket — a component asks it what to
 * offer, and the session core asks it what to send.
 *
 * Legality is answered from `@yaniv/shared`'s rulebook and nowhere else, which is what
 * ADR-0002 moved it there for: a draw target that lit up on a set the server would
 * refuse would cost the player a round trip to find out, and 50–200ms of nothing on a
 * touch screen is indistinguishable from a tap that did not register.
 *
 * What it deliberately does *not* answer is whose turn it is, or anything else the
 * server owns. A selection is legal or it is not; being out of turn comes back as a
 * `GameError`, exactly as it does for the CLI.
 */

import type { Card, DrawAction, PlayerGameView, SelfView, TurnAction } from "@yaniv/shared";
import { canCallYaniv, isValidSet, pickupCandidates } from "@yaniv/shared";

/**
 * The tap that commits a turn: the deck, or one of the face-up cards. Distinct from
 * `DrawAction` — that is the wire's word for it, and this is a card somebody touched,
 * which may well not be a legal draw at all.
 */
export type DrawSource = { kind: "deck" } | { kind: "discard"; cardId: string };

/**
 * A card tapped once joins the selection, a card tapped again leaves it.
 *
 * New arrivals go on the end, because the selection is ordered and the order is the
 * player's: a joker extending a run takes its position from where they put it
 * (docs/rules.md §4), so tap order has to survive all the way to `discardCardIds`.
 */
export function toggleSelection(
  selection: readonly string[],
  cardId: string,
): string[] {
  return selection.includes(cardId)
    ? selection.filter((id) => id !== cardId)
    : [...selection, cardId];
}

/**
 * The selection as it stands against a hand — whatever is still in it, in tap order.
 *
 * A card that leaves the hand leaves the selection with it. Applied to every incoming
 * view, this is what stops a committed turn's cards lingering as a selection over the
 * hand that replaced them.
 */
export function retainSelection(
  selection: readonly string[],
  hand: readonly Card[],
): string[] {
  return selection.filter((id) => hand.some((card) => card.id === id));
}

/**
 * Resolve a selection to the cards it names, or null if it names anything the hand does
 * not hold exactly once.
 *
 * The duplicate check is not paranoia about tapping — a toggle cannot produce one — but
 * the price of being total: two copies of one id would resolve to two equal cards, read
 * as a legal pair, and be sent for the server to refuse with `DUPLICATE_CARDS`.
 */
function resolve(selection: readonly string[], hand: readonly Card[]): Card[] | null {
  if (new Set(selection).size !== selection.length) return null;

  const cards: Card[] = [];
  for (const id of selection) {
    const card = hand.find((c) => c.id === id);
    if (!card) return null;
    cards.push(card);
  }
  return cards;
}

/** Whether the selection is a discard the rules permit — what lights the draw targets. */
export function isLegalSelection(
  selection: readonly string[],
  hand: readonly Card[],
): boolean {
  const cards = resolve(selection, hand);
  return cards !== null && isValidSet(cards);
}

/**
 * Whether calling Yaniv is a move at all: the hand is worth the threshold or less
 * (docs/rules.md §6).
 *
 * Here for the same reason `takeableIds` is — the screen asks this module what to offer
 * and this module asks the rulebook, so a control that lights up and a call the server
 * accepts cannot come apart. It is the hand and nothing else: whose turn it is belongs to
 * the server, exactly as it does for a discard.
 */
export function isLegalCall(hand: readonly Card[]): boolean {
  return canCallYaniv(hand);
}

/**
 * Which of the face-up cards may be taken, by id.
 *
 * Straight off the rulebook rather than re-derived from "first and last" here, so what
 * the screen offers and what the server accepts cannot drift apart.
 */
export function takeableIds(lastDiscard: readonly Card[]): ReadonlySet<string> {
  return new Set(pickupCandidates(lastDiscard).map((card) => card.id));
}

/**
 * Whether the discard pile is a slapdown target — the just-drawn card may go straight
 * back down on the set it matches (docs/rules.md §9).
 *
 * The one question on this screen the rulebook cannot answer. Every other rule here is
 * about cards the client already holds; a window is about the card the *server* dealt
 * off the top of a pile it never sends, so `slapdownEligible` is the answer and there is
 * nothing to re-derive. What this earns is the single place both the screen and the
 * session core ask it: a pile that flashes and a tap that sends cannot come apart.
 *
 * Deliberately no turn check. A window is open precisely when the turn has moved on to
 * the next player — that is what makes it a window — so being off turn is the normal
 * case and never a reason to withhold the target.
 *
 * Takes the `SelfView` rather than the whole position, like `isLegalCall` takes a hand:
 * a window belongs to one player and is told to nobody else, and there is nowhere else
 * in a `PlayerGameView` this could be read from.
 */
export function isSlapdownTarget(you: SelfView): boolean {
  return you.slapdownEligible;
}

/** Where a tapped source draws from, or null when it is not a card on offer. */
function drawFrom(source: DrawSource, view: PlayerGameView): DrawAction | null {
  if (source.kind === "deck") return { source: "deck" };
  return takeableIds(view.lastDiscard).has(source.cardId)
    ? { source: "discard", cardId: source.cardId }
    : null;
}

/**
 * The whole turn a tap commits: the selection discarded and the tapped card drawn, in
 * one action, because the engine has no state in between (see "Turn model" in
 * CLAUDE.md).
 *
 * Null means the interface should not have offered the tap — an illegal selection, or a
 * face-up card that is buried under the ends of the discard. It is not an error to show
 * anybody: nothing was asked for and nothing was refused.
 */
export function turnFrom(
  selection: readonly string[],
  view: PlayerGameView,
  source: DrawSource,
): TurnAction | null {
  if (!isLegalSelection(selection, view.you.hand)) return null;

  const draw = drawFrom(source, view);
  if (draw === null) return null;

  // The selection is the discard, verbatim — tap order is submit order, and that is what
  // decides where a joker extending a run ends up (docs/rules.md §4).
  return { discardCardIds: [...selection], draw };
}
