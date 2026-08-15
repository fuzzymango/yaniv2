/**
 * A scored round: who called Yaniv, whether it stood, and every hand face up.
 *
 * The one screen where nobody's cards are secret. The server reveals every hand at
 * `roundEnd` (see "Serialization is the security boundary" in CLAUDE.md), because that is
 * what makes a call checkable — a player who was Assafed has to be able to see the hand
 * that did it.
 *
 * Laid out as the table it was just played at: everybody in their seat, the viewer at the
 * bottom where they held their own hand (issue #60). What each player's round cost them
 * rides on their seat's label rather than in a list of its own, so everything about one
 * player is read in one place — the same reason their cards are there.
 *
 * Rendered from the round result rather than from the roster, and deliberately: the result
 * names its own players, so a seat survives being given up. See "A finished round names
 * its own players" in CLAUDE.md, and `revealSeats`, which is why this screen is the one
 * that does not sort by `bySeat`.
 *
 * Nothing here decides anything. Only the host deals the next round, and the server is
 * what says so — showing the control to the host alone spares everyone else hunting for a
 * button that was never theirs, exactly as in the lobby.
 */

import type {
  GameError,
  PlayerGameView,
  PlayerRoundResultView,
  RoundResultView,
} from "@yaniv/shared";
import { ZONE_CASCADE } from "./fan.ts";
import { PlayingCard } from "./PlayingCard.tsx";
import { CascadeReveal, Seat, SeatZone } from "./Seat.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { ZONES, revealSeats } from "./seating.ts";

interface RoundEndProps {
  view: PlayerGameView;
  /** The round just scored. Taken as its own prop so the screen cannot be reached without one. */
  result: RoundResultView;
  error: GameError | null;
  busy: boolean;
  onNextRound: () => void;
}

/**
 * What the round cost one player, in the order it is worth reading: whether they did
 * anything, what it came to, and where that leaves them.
 *
 * One component for the seats and for the viewer's own row, so a player cannot be told two
 * different things about the same round depending on where they are sitting — the same
 * reason the lobby and the in-match modal share one settings listing.
 */
function RoundDetail({
  player,
  result,
}: {
  player: PlayerRoundResultView;
  result: RoundResultView;
}) {
  return (
    <>
      {/*
        The sentence at the top of the screen says who did what; these say it again where
        the numbers are, so a seat that gained 30 or nothing can be read without going
        back up to find out why.
      */}
      {player.playerId === result.callerId && <span className="seat__mark">yaniv</span>}
      {player.playerId === result.assaferId && <span className="seat__mark">assaf</span>}
      {/*
        The points this round next to what they made of the score, because a number on its
        own says nothing: +30 is a disaster and +3 is nothing much, and only the total says
        how close anybody is to going out (docs/rules.md §7).

        Signed even at zero, and that is not a flourish: on a seat's label these numbers sit
        in a wrapping row a few characters wide, where a bare `0` beside `0 pts` is two
        numbers nobody can tell apart. The sign is what says which of them is the round.
      */}
      <span className="result__delta">
        {player.delta < 0 ? player.delta : `+${player.delta}`}
      </span>
      <span className="player__score">{player.scoreAfter} pts</span>
      {/* What the hand was worth — the number the whole call turned on. */}
      <span className="result__value">{player.handValue} in hand</span>
    </>
  );
}

export function RoundEnd({ view, result, error, busy, onNextRound }: RoundEndProps) {
  const isHost = view.hostId === view.you.id;

  /** A name off the round's own record, which is the only place a departed seat is left. */
  const named = (id: string) =>
    result.players.find((p) => p.playerId === id)?.name ?? "Somebody";

  /**
   * The sentence at the top is about somebody, and if that somebody is the viewer it says
   * so — "You called Yaniv", not their own name back at them. Which it is can only be
   * decided here, since it depends on whose screen this is.
   */
  const subject = (id: string) => (id === view.you.id ? "You" : named(id));
  const object = (id: string) => (id === view.you.id ? "you" : named(id));

  const { you, zones } = revealSeats(result.players, view.you.id);

  return (
    <main className="screen round">
      {/* The same corner on every in-match screen, so it is always in the same place. */}
      <SettingsDialog settings={view.settings} />

      <header className="round__header">
        <p className="code__label">Round {result.roundNumber}</p>
        <h1 className="round__call">{subject(result.callerId)} called Yaniv</h1>
        {/*
          The verdict in the same breath as the call, because one is meaningless without
          the other: a call that was Assafed cost the caller 30 and won somebody else the
          round (docs/rules.md §6).
        */}
        <p className={`round__verdict ${result.assaferId === null ? "round__verdict--stood" : ""}`}>
          {result.assaferId === null
            ? "It stood."
            : `Assafed by ${object(result.assaferId)}.`}
        </p>
      </header>

      {/*
        Everybody else, in the seats they were just playing from — the same three sides and
        the same upright labels as the live table, so a player's eye does not have to
        re-find anybody between the last move and the score.

        Dealt in the order the round recorded, which is the seating order it was scored in.
        This is the one listing screen that does not sort by `bySeat`, and it cannot: a
        player who has since given up their seat is in no `turnOrder` to be sorted against.
      */}
      <div className="round__seats">
        {ZONES.map((zone) => (
          <SeatZone zone={zone} key={zone}>
            {zones[zone].map((player) => (
              <Seat
                zone={zone}
                name={player.name}
                detail={<RoundDetail player={player} result={result} />}
                key={player.playerId}
              >
                <CascadeReveal cards={player.hand} axis={ZONE_CASCADE[zone]} />
              </Seat>
            ))}
          </SeatZone>
        ))}
      </div>

      {/*
        The viewer's own hand, at the bottom of the screen where they were holding it and
        laid out flat rather than cascaded: it is the one hand with the width of the screen
        to itself, so there is nothing for a cascade to save.

        Absent only if the round scored no row for them at all, which the server does not
        produce — `revealSeats` allows for it rather than seating them on somebody else's
        cards.
      */}
      {you && (
        <section className="round__you">
          <ul className="hand">
            {you.hand.map((card) => (
              <li key={card.id}>
                <PlayingCard card={card} />
              </li>
            ))}
          </ul>
          <p className="you">
            <span className="player__name">{you.name}</span>
            <RoundDetail player={you} result={result} />
          </p>
        </section>
      )}

      <div className="round__actions">
        {isHost ? (
          <button
            className="button button--primary"
            type="button"
            onClick={onNextRound}
            disabled={busy}
          >
            Deal the next round
          </button>
        ) : (
          // Its own class rather than `notice`, which carries news that has just arrived.
          // This is a standing fact about the screen, the same way it is in the lobby.
          <p className="hint">The host deals the next round.</p>
        )}
      </div>

      {error && (
        <p className="notice notice--error" role="alert">
          {error.message}
        </p>
      )}
    </main>
  );
}
