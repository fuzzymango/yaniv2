/**
 * The table: enough of the game to play a turn against, the turn itself, and the moment
 * after the last one.
 *
 * **One screen for `playing`, `roundEnd` and `gameEnd`** (issues #78, #130). A round being
 * scored is the next moment of the hand that was just played, not a different page: the
 * seats stay where they are, the corner icons stay in the corner, and the felt stays under
 * them. What changes is only what actually changed — every hand turns face up in the seat it
 * was already in, each label swaps a running score for what the round made of it, the line
 * above the felt says how the round ended instead of whose turn it is, and the Yaniv call
 * becomes the deal. Three slots change meaning with the phase; nothing on the screen moves.
 *
 * A match ending is the same table again, once more: the last round stays revealed exactly
 * as it was a moment before, and `GameEnd` is drawn over it as a panel (issue #130). What
 * this screen does there is *stop offering things* — the topbar and the bottom slot are the
 * controls a finished match has no use for, and every one of them the panel either carries
 * itself or has replaced. The felt keeps rendering: the deck count, the last discard and the
 * line saying how the final round ended are what the panel is floating over.
 *
 * The seats are placed by the same calculation in both phases — the roster in its own order,
 * sorted by `byRelativeSeat` so the sweep always starts one place along from the viewer's own
 * seat — and the round's own record is looked up against whoever is already sitting there.
 * Two placements could disagree; one cannot. The roster and never turn order (issue #144):
 * a seat holds its place as players go out, and a seat that is out is drawn dim in it.
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

import type { CSSProperties } from "react";
import type {
  GameError,
  OpponentView,
  PlayerGameView,
  PlayerRoundResultView,
  RoundResultView,
  SelfView,
} from "@yaniv/shared";
import { handValue } from "@yaniv/shared";
import { CardsInFlight, useCardFlight } from "./CardsInFlight.tsx";
import { MoveHistory } from "./MoveHistory.tsx";
import { PlayingCard, cardLabel } from "../shared/PlayingCard.tsx";
import { CascadeReveal, OpponentSeat, Seat, SeatZone } from "./Seat.tsx";
import { SettingsDialog } from "../settings/SettingsDialog.tsx";
import { WayOut } from "../shared/WayOut.tsx";
import type { CardFlight } from "../flight.ts";
import type { Landing } from "../ghosts.ts";
import { DECK_BOX } from "../ghosts.ts";
import { roundOutcome, scoreLabel } from "../score.ts";
import type { Zone } from "../seating.ts";
import { ZONES, byRelativeSeat, seatZones } from "../seating.ts";
import { seatStatus } from "../status.ts";
import { SHAKE_MS } from "../timing.ts";
import type { DrawSource } from "../turn.ts";
import { isLegalCall, isLegalSelection, isSlapdownTarget, takeableIds } from "../turn.ts";

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
  /**
   * Deal the next one, where the Yaniv call sat a moment ago. Offered to anyone still in
   * the match, which is everybody who is not watching (docs/adr/0012).
   */
  onNextRound: () => void;
  /** The tap on the pile that sheds the just-drawn card, while a window is open. */
  onSlapDown: () => void;
  /** Give the seat up. Offered where the hand was, to a player who is only watching. */
  onExit: () => void;
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
  wentOut,
}: {
  player: PlayerRoundResultView;
  result: RoundResultView;
  /** Whether this round is the one that took them out of the match — the `OUT` tag. */
  wentOut: boolean;
}) {
  return (
    <>
      {/*
        The line above the felt says who did what; these say it again where the numbers are,
        so a seat that gained 30 or nothing can be read without going back up to find out why.

        The mark for going out is one of them rather than a sentence of its own (issue #142):
        a round that ended somebody's match and one that did not are the same screen in two
        states, and the hand and the score below are the round they actually played, recorded
        before they are dimmed out of the next one.
      */}
      {player.playerId === result.callerId && <span className="seat__mark">yaniv</span>}
      {player.playerId === result.assaferId && <span className="seat__mark">assaf</span>}
      {player.milestoneReduction > 0 && <span className="seat__mark">milestone</span>}
      {wentOut && <span className="seat__mark seat__mark--out">out</span>}
      <span className="player__score">
        {scoreLabel(player.scoreAfter, player.delta, player.milestoneReduction)}
      </span>
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
  onExit,
}: TableProps) {
  const yourTurn = view.currentTurnPlayerId === view.you.id;

  /**
   * The viewer's own seat, narrowed once and here (issue #143): the hand they are holding,
   * or `null` once the match has gone on without them and they are only watching.
   *
   * The narrowing is the phase branch's counterpart and sits beside it, so everything
   * below asks the same question of the same name. What the wire has already settled is
   * that there is nothing to narrow *to* for a spectator — their view carries no hand and
   * no eligibility field at all — so this cannot be the place a hand is invented for one.
   */
  const yours = view.you.spectating ? null : view.you;

  /**
   * Whether there is still a turn to build here, and whether the match this table belongs
   * to is over — the phase asked once each, since every branch below is one of the two.
   *
   * A card is tappable, a draw target is a control and the Yaniv call exists while `live`;
   * `over` is what `GameEnd` is floating on top of, and costs this screen its controls and
   * nothing else (issue #130). Asked of the phase rather than inferred from the round
   * result: the wire type allows a scored phase with no result behind it, and a table that
   * read that as "still playing" would go live again under the panel.
   */
  const live = view.phase === "playing";
  const over = view.phase === "gameEnd";

  /**
   * The round just scored, or null while one is still being played. Read off the view
   * rather than taken as a prop of its own: the phase and the result would then be two
   * claims about the same position, and this screen would have to decide which it believed.
   *
   * `gameEnd` reads the same field as `roundEnd` because it *is* the same field — the
   * serializer populates `roundResult` in both, and the last round of a match is revealed
   * the way every other one was rather than by a second codepath that could reveal it
   * differently (issue #130).
   */
  const result = live ? null : view.roundResult;

  /**
   * Whether a draw target does anything. The selection is the whole of it, once the round
   * itself is: a tap that would be refused for any *other* reason is still offered, because
   * those reasons are the server's and a second opinion here could only ever disagree.
   */
  const canDraw = live && !busy && yours !== null && isLegalSelection(selection, yours.hand);
  const takeable = takeableIds(view.lastDiscard);

  /**
   * Whether the Yaniv control does anything — the hand, and nothing but the hand
   * (docs/rules.md §6). Being off turn leaves it live and is answered by the server with
   * `NOT_YOUR_TURN`, the same way a draw target is: this screen enforces the rules of the
   * cards and none of the rules about whose go it is.
   */
  const canCall =
    live && !busy && yours !== null && isLegalCall(yours.hand, view.settings.yanivThreshold);

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
  const { rootRef, landing, flying, jolt, settle } = useCardFlight(flight, view.you.id);

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

  const zones = seatZones([...view.opponents].sort(byRelativeSeat(view)));

  const seated = [view.you, ...view.opponents];

  /**
   * Who a player id belongs to, off the live roster. Used by the line above the felt and by
   * the move history, which names movers and is sent ids — and said once, so a seat nobody
   * on this screen can account for is called the same thing in both places.
   */
  const nameOf = (id: string | null): string =>
    seated.find((player) => player.id === id)?.name ?? "Somebody";

  /** The round's own record for a player, or null while the round is still being played. */
  const scored = (id: string): PlayerRoundResultView | null =>
    result?.players.find((player) => player.playerId === id) ?? null;

  /**
   * Whether the round on the screen is the one that took this seat out of the match
   * (docs/rules.md §7). Read off the seat's own standing against the round being *shown*
   * rather than against `view.roundNumber`: they are the same number at `roundEnd`, and
   * the record is what the rest of this screen is drawing.
   */
  const wentOut = (player: SelfView | OpponentView): boolean =>
    result !== null && player.outInRound === result.roundNumber;

  /**
   * Whether the match has gone on without this seat, as of the position on the screen
   * (issue #144) — what darkens it, where it has sat all match.
   *
   * Out, *and* out before the round being shown: the round that took somebody out is scored
   * with them in it, and their hand and their score in it are exactly what a scored table is
   * for reading. So the seat wears the news that round (`wentOut`, the `OUT` tag) and is dim
   * from the next deal on, which is the first position they are genuinely not in.
   */
  const isOut = (player: SelfView | OpponentView): boolean =>
    player.outInRound !== null && !wentOut(player);

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
          isOut={isOut(opponent)}
          key={opponent.id}
        />
      );
    }
    return (
      <Seat
        zone={zone}
        name={opponent.name}
        isOut={isOut(opponent)}
        wentOut={wentOut(opponent)}
        // The same slot the live seat carries (issue #146): who is there is as true of a
        // round being scored as of one being played, and a seat that says "away" while the
        // table waits on the deal is saying exactly what is worth knowing.
        status={seatStatus(opponent)}
        detail={<ScoredDetail player={row} result={result} wentOut={wentOut(opponent)} />}
        key={opponent.id}
      >
        <CascadeReveal cards={row.hand} zone={zone} />
      </Seat>
    );
  };

  /** The viewer's own row of the round, for the footer under their revealed hand. */
  const yourRound = scored(view.you.id);
  const youWentOut = wentOut(view.you);

  /**
   * The cards to lay out where this player's hand goes, or `null` when there are none and
   * the bar goes there instead (issue #143).
   *
   * A watcher has no hand — with one exception, and it is the round that took them out:
   * that round is scored with them in it, so its record still holds the hand they actually
   * played, and it is read here off `roundResult` exactly as every other seat's is. Being
   * dimmed out of the *next* round does not retract the last one. From the following deal
   * on there is no record of theirs to find, and the bar is what the row says.
   */
  const handShown = yours !== null ? yours.hand : (yourRound?.hand ?? null);

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
          : { said: `${nameOf(view.currentTurnPlayerId)} is playing`, tone: "" };

  return (
    <>
      {/*
        The table, and — for the length of a slapdown's aftershock — the table being knocked
        (issue #95). The class is worn by the whole felt rather than by the pile, because what
        a slapdown is worth showing is the room reacting to it, and it is taken off again by
        the layer that put it on. The keyframe is transform-only and the element it moves is
        the one every control here is already inside, so a tap during it lands exactly where
        it looks like it lands, and the jolt costs nobody a move.

        How long it lasts comes down from the timing chain (`timing.ts`) rather than being a
        number in the stylesheet: the shake is the last link of it, and a keyframe tuned to a
        flight it no longer matches is exactly what deriving the lot was for. The stylesheet
        keeps what it is better at — how far the table moves, and in which directions.
      */}
      <main
        className={`screen table${jolt ? " table--jolt" : ""}`}
        style={{ "--jolt-ms": `${SHAKE_MS}ms` } as CSSProperties}
        ref={rootRef}
      >
        {/*
          The corner every in-match screen carries, and the room's locked settings are the
          whole of it: one tap away and nowhere on the table itself — what a Yaniv may be
          called on is worth being able to check, and worth nothing at all in front of a
          player who is looking at their hand.

          There is nothing else here any more. The host's close-room icon stood beside it
          until issue #145, and no control on a running table ends anybody's match now
          (docs/adr/0012).

          Gone once the match is over: the panel over this table carries its own settings
          icon and its own way out, and two of each on one screen would be two answers to
          the same tap (issue #130).
        */}
        {!over && (
          <div className="topbar">
            <SettingsDialog settings={view.settings} />
          </div>
        )}

        {/*
          The round so far, behind an arrow on the left edge (issues #89, #91) — and only
          while it is still being played. A scored round is already the whole story told at
          full size in the seats, so a drawer listing the same moves in icons would be
          competing with the reveal rather than adding to it. The phase and not `result`,
          because it is the phase the rule is about: `moveHistory` still arrives at
          `roundEnd`, and this screen simply stops drawing it.
        */}
        {live && <MoveHistory entries={view.moveHistory} nameOf={nameOf} />}

        {/*
          Everybody else, seated round three sides of the felt with the viewer holding the
          fourth. Each seat is their hand as it actually stands — one face-down card per card
          they are holding — so a hand shrinking or growing is something to see rather than a
          number to notice.

          Which side anyone is on is `seatZones`, off the room's roster rebased on the viewer's
          own seat (`byRelativeSeat`), so the sweep always starts one place along from them —
          and off the same list once the round is scored, where the fans turn face up where
          they already are. A seat the match has gone on without keeps its place there and is
          drawn dim, so the table never rearranges itself around whoever is left (issue #144).
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
          control somewhere else (issue #78). Everybody still in the match gets that button
          — nobody is host once the cards are out (docs/adr/0012), and a table should not be
          waiting on one particular person — and a player the match has gone on without gets
          the line instead, which is the same rule the server states as `NOT_IN_MATCH`.

          Empty once the match is over: both things this slot can say are about a round that
          is coming, and there is not one. Dealing again is a whole match and is asked for on
          the panel, beside leaving (issue #130).
        */}
        {/*
          Nothing at all where the Yaniv call is, for a player who is only watching: the
          one thing that slot ever offers mid-round is a move, and they have none. The
          scored-round branch below is left alone deliberately — dealing the next round is
          not a move in a hand, and who may ask for it is the server's rule.
        */}
        {over || (live && yours === null) ? null : live ? (
          <button
            className={`button call ${canCall ? "call--live" : ""}`}
            type="button"
            disabled={!canCall}
            onClick={onCallYaniv}
          >
            Yaniv!
          </button>
        ) : yours !== null ? (
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
          <p className="hint">Waiting for the next round.</p>
        )}

        {/*
          The viewer's own hand, in the order the server sorted it and in no other: sorting
          again here would rearrange a hand under a player's finger between one move and the
          next. See "Hand display order is presentation only" in CLAUDE.md.

          Face up and untappable once the round is scored — there is no turn left to build,
          and a card that lifted under a thumb would be offering one.

          Where there are no cards to lay out, the row says why (issue #143): a bar of about
          the same height, so the felt and every seat above it keep the position they had
          while this player was still playing. One control in it and no other — nothing here
          should read as a move — and it is the `WayOut` every other screen offers, which
          reads "Leave the room" for everybody now that no seat can end anybody else's match
          (docs/adr/0012).

          Nothing at all at `gameEnd`: the panel over this table carries its own way out,
          and the bottom of the screen is given up there exactly as the topbar is.
        */}
        {handShown !== null ? (
          <ul className="hand">
            {handShown.map((card) => {
              const chosen = selection.includes(card.id);
              return (
                // A card still on its way into the hand keeps its place in the row and waits
                // there — the face only, so it can be tapped into a selection the whole time
                // it is arriving, exactly as it could if nothing were in the air.
                <li className={landingClass(card.id, "hand")} key={card.id}>
                  {live ? (
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
        ) : over ? null : (
          <div className="spectating">
            <span className="spectating__said">
              You are out of the match — watching the rest of it.
            </span>
            <WayOut busy={busy} onExit={onExit} />
          </div>
        )}

        {/*
          The same row in both phases, in the same place. What it says changes with what is
          worth knowing: while the hand is being played, what it is worth — the number the
          Yaniv control turns on, so it is worth knowing without adding the cards up, and
          what says how far off a call still is. Once the round is scored the cards are face
          up and that number is there to be read off them, so the row says where the round
          left this player instead, in the words every seat's label uses.
        */}
        <footer
          className={`you ${live && yourTurn ? "you--turn" : ""} ${
            youWentOut ? "you--went-out" : ""
          }`}
        >
          <span className="player__name">{view.you.name}</span>
          {result !== null && yourRound !== null ? (
            <ScoredDetail player={yourRound} result={result} wentOut={youWentOut} />
          ) : (
            <>
              {/*
                What the hand is worth, where there is one to weigh: a watcher's row keeps
                their name and their frozen total, and says nothing about cards they are
                not holding.
              */}
              {yours !== null && (
                <span className="you__value">{handValue(yours.hand)} in hand</span>
              )}
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
      <CardsInFlight flying={flying} onSettled={settle} />
    </>
  );
}
