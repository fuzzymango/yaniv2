/**
 * The table: enough of the game to play a turn against, and the turn itself.
 *
 * A turn is two taps and no button. Cards are tapped to build a selection, and the next
 * tap — on the deck, or on an end of the face-up discard — *is* the commit: the selection
 * is discarded and that card drawn, in one action, because the engine has no state in
 * between (see "Turn model" in CLAUDE.md, and "Selection" in CONTEXT.md).
 *
 * Draw targets are dead until the selection is a legal discard, so an illegal set is
 * never offered rather than being sent and refused. That is the only rule this screen
 * enforces, and it enforces it out of the same rulebook the server judges by (ADR-0002) —
 * a round trip to be told no is 50-200ms of nothing, which on a phone is indistinguishable
 * from a tap that did not register. Everything the server owns is left to the server:
 * playing out of turn is offered, sent, and answered with `NOT_YOUR_TURN`.
 *
 * Nothing here is stateful. The selection lives in the session core, because it has to
 * survive views arriving underneath it.
 */

import type { GameError, PlayerGameView } from "@yaniv/shared";
import { handValue } from "@yaniv/shared";
import { PlayingCard, cardLabel } from "./PlayingCard.tsx";
import { bySeat } from "./seating.ts";
import type { DrawSource } from "./turn.ts";
import { isLegalCall, isLegalSelection, isSlapdownTarget, takeableIds } from "./turn.ts";

interface TableProps {
  view: PlayerGameView;
  selection: readonly string[];
  error: GameError | null;
  busy: boolean;
  onToggleCard: (cardId: string) => void;
  /** The tap that plays the turn — a draw target, because the draw *is* the commit. */
  onCommitTurn: (source: DrawSource) => void;
  /** End the round. Offered only on a hand the rules allow it on — see below. */
  onCallYaniv: () => void;
  /** The tap on the pile that sheds the just-drawn card, while a window is open. */
  onSlapDown: () => void;
}

export function Table({
  view,
  selection,
  error,
  busy,
  onToggleCard,
  onCommitTurn,
  onCallYaniv,
  onSlapDown,
}: TableProps) {
  const yourTurn = view.currentTurnPlayerId === view.you.id;

  /**
   * Whether a draw target does anything. The selection is the whole of it: a tap that
   * would be refused for any *other* reason is still offered, because those reasons are
   * the server's and a second opinion here could only ever disagree with it.
   */
  const canDraw = !busy && isLegalSelection(selection, view.you.hand);
  const takeable = takeableIds(view.lastDiscard);

  /**
   * Whether the Yaniv control does anything — the hand, and nothing but the hand
   * (docs/rules.md §6). Being off turn leaves it live and is answered by the server with
   * `NOT_YOUR_TURN`, the same way a draw target is: this screen enforces the rules of the
   * cards and none of the rules about whose go it is.
   */
  const canCall = !busy && isLegalCall(view.you.hand);

  /**
   * Whether the pile is a slapdown target rather than a row of draw targets
   * (docs/rules.md §9) — the two meanings a tap on it could have, and it may only have
   * one. While a window is open the turn is somebody else's, so a draw off this pile is
   * a move the server would refuse anyway, and the slap is the move actually there to
   * make. The deck is left alone: it is not this pile, and nothing about it changes.
   */
  const slapdownTarget = isSlapdownTarget(view.you);

  const opponents = [...view.opponents].sort(bySeat(view));

  const onTurn = [view.you, ...view.opponents].find(
    (p) => p.id === view.currentTurnPlayerId,
  );

  return (
    <main className="screen table">
      <ul className="players">
        {opponents.map((opponent) => (
          <li
            className={`player ${opponent.id === view.currentTurnPlayerId ? "player--turn" : ""}`}
            key={opponent.id}
          >
            <span className="player__name">{opponent.name}</span>
            <span className="player__cards">{opponent.handSize} cards</span>
            <span className="player__score">{opponent.score} pts</span>
          </li>
        ))}
      </ul>

      <section className="felt">
        {/*
          The deck. Its count is the honest one the server sends — a count and nothing
          more, because the draw pile's contents never leave the server.
        */}
        <button
          className="pick pick--deck"
          type="button"
          aria-label={`Draw from the deck, ${view.drawPileCount} cards left`}
          disabled={!canDraw}
          onClick={() => onCommitTurn({ kind: "deck" })}
        >
          <span className="card card--back" />
          <span className="pick__count">{view.drawPileCount}</span>
        </button>

        {slapdownTarget ? (
          /*
            The whole pile as one target, flashing, for as long as the window lasts. It
            is one control rather than a card each because there is only one card it
            could be about — a player draws one card a turn, so the server already knows
            which — and because a pile that offered both meanings at once would make a
            tap a guess.

            Locked on `busy` the moment it is tapped rather than on the ack, so a thumb
            that lands twice sends once. Correctness does not rest on that: a second slap
            is refused by the server for free.
          */
          <button
            className="slapdown"
            type="button"
            aria-label="Slap down the card you just drew"
            disabled={busy}
            onClick={onSlapDown}
          >
            {view.lastDiscard.map((card) => (
              <PlayingCard card={card} key={card.id} />
            ))}
          </button>
        ) : (
          /*
            The last discard, laid out as it lies. Which of it may be taken comes from the
            rulebook, not from counting to the ends here — so whatever is not on offer is
            rendered without a control at all and dimmed, rather than as buttons that
            quietly do nothing.
          */
          <ul className="discard">
            {view.lastDiscard.map((card) =>
              takeable.has(card.id) ? (
                <li key={card.id}>
                  <button
                    className="pick"
                    type="button"
                    aria-label={`Take the ${cardLabel(card)}`}
                    disabled={!canDraw}
                    onClick={() => onCommitTurn({ kind: "discard", cardId: card.id })}
                  >
                    <PlayingCard card={card} />
                  </button>
                </li>
              ) : (
                // Deliberately not a `.pick`: there is no control here at all, so there is
                // nothing to give it a pointer cursor or a focus stop either.
                <li className="discard__out" key={card.id}>
                  <PlayingCard card={card} />
                </li>
              ),
            )}
          </ul>
        )}
      </section>

      {/*
        A window says what it is in words as well as in the flashing, because it is the
        one thing on this screen that is not a rule about the cards in front of the
        player: nothing they can see explains why the pile has started asking for a tap.
        It goes above whose turn it is, which is true at the same time and matters less
        for as long as the window lasts.
      */}
      <p
        className={`turn ${yourTurn ? "turn--yours" : ""} ${slapdownTarget ? "turn--slap" : ""}`}
        role="status"
      >
        {slapdownTarget
          ? "Slapdown! Tap the pile to send the card you just drew straight back"
          : yourTurn
            ? "Your turn — tap cards, then the deck or a face-up card"
            : `${onTurn?.name ?? "Somebody"} is playing`}
      </p>

      {/*
        The call that replaces a turn rather than taking one, so it is a button where
        nothing else on this screen is one — there is no set to choose and nothing to draw.

        Always on the screen and inert until the hand is low enough, rather than appearing
        when it becomes legal: a control that materialises under a thumb already on its way
        down is one nobody meant to press, and a permanent one also tells a player what
        they are playing towards.
      */}
      <button
        className={`button call ${canCall ? "call--live" : ""}`}
        type="button"
        disabled={!canCall}
        onClick={onCallYaniv}
      >
        Yaniv!
      </button>

      {/*
        In the order the server sorted them and in no other: sorting again here would
        rearrange a hand under a player's finger between one move and the next. See
        "Hand display order is presentation only" in CLAUDE.md.
      */}
      <ul className="hand">
        {view.you.hand.map((card) => {
          const chosen = selection.includes(card.id);
          return (
            <li key={card.id}>
              <button
                className={`pick ${chosen ? "pick--chosen" : ""}`}
                type="button"
                aria-label={cardLabel(card)}
                aria-pressed={chosen}
                disabled={busy}
                onClick={() => onToggleCard(card.id)}
              >
                <PlayingCard card={card} />
              </button>
            </li>
          );
        })}
      </ul>

      <footer className="you">
        <span className="player__name">{view.you.name}</span>
        {/*
          The number the Yaniv control turns on, so it is worth a player knowing without
          adding their own hand up — and it is what says how far off a call still is.
        */}
        <span className="you__value">{handValue(view.you.hand)} in hand</span>
        <span className="player__score">{view.you.score} pts</span>
      </footer>

      {error && (
        <p className="notice notice--error" role="alert">
          {error.message}
        </p>
      )}
    </main>
  );
}
