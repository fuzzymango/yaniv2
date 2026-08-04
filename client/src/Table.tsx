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
import { isLegalSelection, takeableIds } from "./turn.ts";

interface TableProps {
  view: PlayerGameView;
  selection: readonly string[];
  error: GameError | null;
  busy: boolean;
  onToggleCard: (cardId: string) => void;
  /** The tap that plays the turn — a draw target, because the draw *is* the commit. */
  onCommitTurn: (source: DrawSource) => void;
}

export function Table({
  view,
  selection,
  error,
  busy,
  onToggleCard,
  onCommitTurn,
}: TableProps) {
  const yourTurn = view.currentTurnPlayerId === view.you.id;

  /**
   * Whether a draw target does anything. The selection is the whole of it: a tap that
   * would be refused for any *other* reason is still offered, because those reasons are
   * the server's and a second opinion here could only ever disagree with it.
   */
  const canDraw = !busy && isLegalSelection(selection, view.you.hand);
  const takeable = takeableIds(view.lastDiscard);

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

        {/*
          The last discard, laid out as it lies. Only its two ends may be taken — which
          comes from the rulebook, not from counting to the ends here — so the cards
          between them are rendered without a control at all and dimmed, rather than as
          buttons that quietly do nothing.
        */}
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
      </section>

      <p className={`turn ${yourTurn ? "turn--yours" : ""}`} role="status">
        {yourTurn
          ? "Your turn — tap cards, then the deck or a face-up card"
          : `${onTurn?.name ?? "Somebody"} is playing`}
      </p>

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
          The number that decides whether Yaniv can be called, so it is worth a player
          knowing without adding their own hand up. What to do about it is #36's screen.
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
