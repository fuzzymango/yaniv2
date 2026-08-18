/**
 * The table: enough of the game to play a turn against, the turn itself, and the moment
 * after the last one.
 *
 * **One screen for `playing` and `roundEnd`** (issue #78). A round being scored is the next
 * moment of the hand that was just played, not a different page: the seats stay where they
 * are, the corner icons stay in the corner, and the felt stays under them. What changes is
 * only what actually changed — every hand turns face up in the seat it was already in, each
 * label swaps a running score for what the round made of it, the line above the felt says
 * how the round ended instead of whose turn it is, and the Yaniv call becomes the deal.
 * Three slots change meaning with the phase; nothing on the screen moves.
 *
 * The seats are placed by the same calculation in both phases — the live roster, sorted by
 * `bySeat` — and the round's own record is looked up against whoever is already sitting
 * there. Two placements could disagree; one cannot.
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
 * Nothing about the *game* is stateful here. The selection lives in the session core,
 * because it has to survive views arriving underneath it. The one piece of state on this
 * screen is the flight (`useCardFlight`), which is a picture of a move already played and
 * decides nothing — see `CardsInFlight.tsx`.
 */

import type {
  GameError,
  OpponentView,
  PlayerGameView,
  PlayerRoundResultView,
  RoundResultView,
} from "@yaniv/shared";
import { handValue } from "@yaniv/shared";
import { CardsInFlight, useCardFlight } from "./CardsInFlight.tsx";
import { PlayingCard, cardLabel } from "./PlayingCard.tsx";
import { CascadeReveal, OpponentSeat, Seat, SeatZone } from "./Seat.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { CloseRoomIcon } from "./WayOut.tsx";
import type { CardFlight } from "./flight.ts";
import type { Landing } from "./ghosts.ts";
import { DECK_BOX } from "./ghosts.ts";
import { roundOutcome, scoreLabel } from "./score.ts";
import type { Zone } from "./seating.ts";
import { ZONES, bySeat, seatZones } from "./seating.ts";
import type { DrawSource } from "./turn.ts";
import { isLegalCall, isLegalSelection, isSlapdownTarget, takeableIds } from "./turn.ts";

interface TableProps {
  view: PlayerGameView;
  selection: readonly string[];
  error: GameError | null;
  busy: boolean;
  /**
   * The move this position was reached by, if it is one worth watching happen. A one-shot
   * off the session snapshot, handed straight to the flight layer and read nowhere else on
   * this screen — the table itself draws the position, not how it got here.
   */
  flight: CardFlight | null;
  onToggleCard: (cardId: string) => void;
  /** The tap that plays the turn — a draw target, because the draw *is* the commit. */
  onCommitTurn: (source: DrawSource) => void;
  /** End the round. Offered only on a hand the rules allow it on — see below. */
  onCallYaniv: () => void;
  /** Deal the next one. Offered to the host alone, where the Yaniv call sat a moment ago. */
  onNextRound: () => void;
  /** The tap on the pile that sheds the just-drawn card, while a window is open. */
  onSlapDown: () => void;
  /** End the room. Offered to the host alone — see `WayOut.tsx`. */
  onCloseRoom: () => void;
}

/**
 * What a scored round says about one player, beside their own cards: whether they did
 * anything, and where the round leaves them.
 *
 * One component for the seats and for the viewer's own footer, so a player cannot be told
 * two different things about the same round depending on where they are sitting — the same
 * reason the lobby and the in-match modal share one settings listing.
 */
function ScoredDetail({
  player,
  result,
}: {
  player: PlayerRoundResultView;
  result: RoundResultView;
}) {
  return (
    <>
      {/*
        The line above the felt says who did what; these say it again where the numbers are,
        so a seat that gained 30 or nothing can be read without going back up to find out why.
      */}
      {player.playerId === result.callerId && <span className="seat__mark">yaniv</span>}
      {player.playerId === result.assaferId && <span className="seat__mark">assaf</span>}
      <span className="player__score">{scoreLabel(player.scoreAfter, player.delta)}</span>
    </>
  );
}

export function Table({
  view,
  selection,
  error,
  busy,
  flight,
  onToggleCard,
  onCommitTurn,
  onCallYaniv,
  onNextRound,
  onSlapDown,
  onCloseRoom,
}: TableProps) {
  const yourTurn = view.currentTurnPlayerId === view.you.id;
  const isHost = view.hostId === view.you.id;

  /**
   * The round just scored, or null while one is still being played. Read off the view
   * rather than taken as a prop of its own: the phase and the result would then be two
   * claims about the same position, and this screen would have to decide which it believed.
   */
  const result = view.phase === "roundEnd" ? view.roundResult : null;

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
  const canCall = !busy && isLegalCall(view.you.hand, view.settings.yanivThreshold);

  /**
   * Whether the pile is a slapdown target rather than a row of draw targets
   * (docs/rules.md §9) — the two meanings a tap on it could have, and it may only have
   * one. While a window is open the turn is somebody else's, so a draw off this pile is
   * a move the server would refuse anyway, and the slap is the move actually there to
   * make. The deck is left alone: it is not this pile, and nothing about it changes.
   */
  const slapdownTarget = isSlapdownTarget(view.you);

  /*
   * The cards of the move this position was reached by, on their way to where the position
   * already has them — out of the hand onto the pile, and the drawn card back the other way.
   * Nothing else on this screen reads it: `landing` says which cards are still in the air so
   * their place can be left empty, and the layer draws them. See `CardsInFlight.tsx` — it is
   * decorative from end to end, and no control below waits on it.
   */
  const { rootRef, landing, ghosts, settle } = useCardFlight(flight, view.you.id);

  /**
   * A place whose card is still in the air. Said once here and worn by whatever encloses the
   * card: the control keeps its box, its ring and its flash, and only the face inside it
   * waits (`.landing .card` in `styles.css`).
   *
   * The place is asked about as well as the card, because a card can be drawn in two of them
   * at once — a slapdown inside a flight puts the card still arriving in the hand onto the
   * pile, where it has genuinely landed and has nothing to wait for.
   */
  const landingClass = (cardId: string, place: Landing): string =>
    landing.get(cardId) === place ? "landing" : "";

  /**
   * The pile as a whole, for the one control that is the whole pile. Everything on it is the
   * discard that has just been played, so a slapdown window — which opens on the viewer's own
   * move — opens over cards that have not arrived yet.
   */
  const pileLanding = view.lastDiscard.some((card) => landing.get(card.id) === "pile");

  const zones = seatZones([...view.opponents].sort(bySeat(view)));

  const onTurn = [view.you, ...view.opponents].find(
    (p) => p.id === view.currentTurnPlayerId,
  );

  /** The round's own record for a player, or null while the round is still being played. */
  const scored = (id: string): PlayerRoundResultView | null =>
    result?.players.find((player) => player.playerId === id) ?? null;

  /**
   * One opponent in their zone, in whichever of the two shapes the phase calls for — the
   * fan they were holding, or the same hand face up in the same seat.
   *
   * The seat is chosen before the round is consulted, never the other way round: which zone
   * anybody is in comes off the live roster in both phases, and the round's record only says
   * what to draw in it.
   */
  const seatFor = (zone: Zone, opponent: OpponentView) => {
    const row = scored(opponent.id);
    if (result === null || row === null) {
      return (
        <OpponentSeat
          zone={zone}
          opponent={opponent}
          isTurn={opponent.id === view.currentTurnPlayerId}
          key={opponent.id}
        />
      );
    }
    return (
      <Seat
        zone={zone}
        name={opponent.name}
        detail={<ScoredDetail player={row} result={result} />}
        key={opponent.id}
      >
        <CascadeReveal cards={row.hand} zone={zone} />
      </Seat>
    );
  };

  /** The viewer's own row of the round, for the footer under their revealed hand. */
  const yourRound = scored(view.you.id);

  /*
   * What the one line above the felt says, and how loudly. Four things can be true of a
   * position and only one of them is ever the news: how the round ended, that a window is
   * open, that it is this player's go, or whose it is instead. Sentence and tone come out of
   * one branch rather than two, since a colour saying one thing over words saying another is
   * the only way this line can be wrong.
   */
  const line =
    result !== null
      ? {
          said: roundOutcome(result, view.you.id),
          tone: result.assaferId === null ? "turn--stood" : "turn--assaf",
        }
      : slapdownTarget
        ? {
            said: "Slapdown! Tap the pile to send the card you just drew straight back",
            tone: "turn--slap",
          }
        : yourTurn
          ? {
              said: "Your turn — tap cards, then the deck or a face-up card",
              tone: "turn--yours",
            }
          : { said: `${onTurn?.name ?? "Somebody"} is playing`, tone: "" };

  return (
    <>
      <main className="screen table" ref={rootRef}>
        {/*
          The corner every in-match screen carries. The room's locked settings, one tap away
          and nowhere on the table itself — what a Yaniv may be called on is worth being able
          to check, and worth nothing at all in front of a player who is looking at their
          hand — and, for the host, the only thing that ends a room mid-round.
        */}
        <div className="topbar">
          {isHost && <CloseRoomIcon busy={busy} onClose={onCloseRoom} />}
          <SettingsDialog settings={view.settings} />
        </div>

        {/*
          Everybody else, seated round three sides of the felt with the viewer holding the
          fourth. Each seat is their hand as it actually stands — one face-down card per card
          they are holding — so a hand shrinking or growing is something to see rather than a
          number to notice.

          Which side anyone is on is `seatZones`, off the seating order the server sends, so
          the table reads the same way round on everybody's screen — and off the same list
          once the round is scored, where the fans turn face up where they already are.
        */}
        <div className="table__seats">
          {ZONES.map((zone) => (
            <SeatZone zone={zone} key={zone}>
              {zones[zone].map((opponent) => seatFor(zone, opponent))}
            </SeatZone>
          ))}
        </div>

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
            {/*
              Measured by the flight layer without being a card (`DECK_BOX`, and each seat's
              own box is the other): a card drawn off here was nowhere on the screen a moment
              ago, so the deck is where its journey starts. The back stays put throughout —
              the deck is a pile, not the card that left it.
            */}
            <span className="card card--back" data-flight-box={DECK_BOX} />
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
              // Still live and still flashing while the cards it is about arrive: only the
              // faces inside it wait (`.landing .card`), never the control.
              className={`slapdown ${pileLanding ? "landing" : ""}`}
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
                  // A card still in the air leaves its place empty rather than sitting in it
                  // twice — the face only, so the draw target underneath it stays a control.
                  <li className={landingClass(card.id, "pile")} key={card.id}>
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
                  <li className={`discard__out ${landingClass(card.id, "pile")}`} key={card.id}>
                    <PlayingCard card={card} />
                  </li>
                ),
              )}
            </ul>
          )}
        </section>

        {/*
          One line, three things to say and only ever one of them at a time.

          A window says what it is in words as well as in the flashing, because it is the
          one thing on this screen that is not a rule about the cards in front of the
          player: nothing they can see explains why the pile has started asking for a tap.
          It goes above whose turn it is, which is true at the same time and matters less
          for as long as the window lasts.

          And once the round is scored this same line says how it ended, rather than a
          heading appearing above the seats and pushing every one of them down the page
          (issue #78). The two facts are one sentence because neither means anything without
          the other: a call that was Assafed cost the caller 30 and won somebody else the
          round (docs/rules.md §6).
        */}
        <p className={`turn ${line.tone}`} role="status">
          {line.said}
        </p>

        {/*
          One slot, and whatever this player can do from here.

          During play it is the call that replaces a turn rather than taking one, so it is a
          button where nothing else on this screen is one — there is no set to choose and
          nothing to draw. Always on the screen and inert until the hand is low enough,
          rather than appearing when it becomes legal: a control that materialises under a
          thumb already on its way down is one nobody meant to press, and a permanent one
          also tells a player what they are playing towards.

          Once the round is scored it is the deal, in the same place rather than as a new
          control somewhere else (issue #78) — and for everybody but the host it is the
          reason there is no button, exactly as in the lobby.
        */}
        {result === null ? (
          <button
            className={`button call ${canCall ? "call--live" : ""}`}
            type="button"
            disabled={!canCall}
            onClick={onCallYaniv}
          >
            Yaniv!
          </button>
        ) : isHost ? (
          <button
            className="button button--primary deal"
            type="button"
            disabled={busy}
            onClick={onNextRound}
          >
            Deal the next round
          </button>
        ) : (
          // Its own class rather than `notice`, which carries news that has just arrived.
          // This is a standing fact about the screen, the same way it is in the lobby.
          <p className="hint">The host deals the next round.</p>
        )}

        {/*
          In the order the server sorted them and in no other: sorting again here would
          rearrange a hand under a player's finger between one move and the next. See
          "Hand display order is presentation only" in CLAUDE.md.

          Face up and untappable once the round is scored — there is no turn left to build,
          and a card that lifted under a thumb would be offering one.
        */}
        <ul className="hand">
          {view.you.hand.map((card) => {
            const chosen = selection.includes(card.id);
            return (
              // A card still on its way into the hand keeps its place in the row and waits
              // there — the face only, so it can be tapped into a selection the whole time
              // it is arriving, exactly as it could if nothing were in the air.
              <li className={landingClass(card.id, "hand")} key={card.id}>
                {result === null ? (
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
                ) : (
                  <PlayingCard card={card} />
                )}
              </li>
            );
          })}
        </ul>

        {/*
          The same row in both phases, in the same place. What it says changes with what is
          worth knowing: while the hand is being played, what it is worth — the number the
          Yaniv control turns on, so it is worth knowing without adding the cards up, and
          what says how far off a call still is. Once the round is scored the cards are face
          up and that number is there to be read off them, so the row says where the round
          left this player instead, in the words every seat's label uses.
        */}
        <footer className="you">
          <span className="player__name">{view.you.name}</span>
          {result !== null && yourRound !== null ? (
            <ScoredDetail player={yourRound} result={result} />
          ) : (
            <>
              <span className="you__value">{handValue(view.you.hand)} in hand</span>
              <span className="player__score">{view.you.score} pts</span>
            </>
          )}
        </footer>

        {error && (
          <p className="notice notice--error" role="alert">
            {error.message}
          </p>
        )}

      </main>

      {/*
        Over the screen and deliberately outside it: the cards of the move that produced this
        position, drawn crossing the table on their way to the places left empty for them
        above. It is fixed to the viewport and inert to every tap, so it is part of no layout
        — and a ghost is a copy of a card, carrying the same id, so a layer *inside* the
        measured screen would answer for the card it copies. See `measure` in
        `CardsInFlight.tsx`.
      */}
      <CardsInFlight ghosts={ghosts} onSettled={settle} />
    </>
  );
}
