/**
 * A scored round: who called Yaniv, whether it stood, and every hand face up.
 *
 * The one screen where nobody's cards are secret. The server reveals every hand at
 * `roundEnd` (see "Serialization is the security boundary" in CLAUDE.md), because that is
 * what makes a call checkable — a player who was Assafed has to be able to see the hand
 * that did it.
 *
 * Rendered from the round result rather than from the roster, and deliberately: the result
 * names its own players, so a row survives a seat being given up. See "A finished round
 * names its own players" in CLAUDE.md.
 *
 * Nothing here decides anything. Only the host deals the next round, and the server is
 * what says so — showing the control to the host alone spares everyone else hunting for a
 * button that was never theirs, exactly as in the lobby.
 */

import type { GameError, PlayerGameView, RoundResultView } from "@yaniv/shared";
import { PlayingCard } from "./PlayingCard.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";

interface RoundEndProps {
  view: PlayerGameView;
  /** The round just scored. Taken as its own prop so the screen cannot be reached without one. */
  result: RoundResultView;
  error: GameError | null;
  busy: boolean;
  onNextRound: () => void;
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
        In the order the round recorded them, which is the seating order it was scored in —
        the same order every other screen lists the table in, so a player's eye does not
        have to re-find anybody.

        The one listing screen that does not sort by `bySeat`, and it cannot: these rows
        come from the round's own record, which may name a player who has since given up
        their seat and so is in no `turnOrder` to be sorted against.
      */}
      <ul className="results">
        {result.players.map((player) => (
          <li className="result" key={player.playerId}>
            <div className="result__line">
              <span className="player__name">{player.name}</span>
              {player.playerId === view.you.id && <span className="seat__mark">you</span>}
              {/*
                The sentence above says who did what; these say it again where the numbers
                are, so a row that gained 30 or nothing can be read without going back up.
              */}
              {player.playerId === result.callerId && (
                <span className="seat__mark">yaniv</span>
              )}
              {player.playerId === result.assaferId && (
                <span className="seat__mark">assaf</span>
              )}
              {/*
                The points this round next to what they made of the score, because a
                number on its own says nothing: +30 is a disaster and +3 is nothing much,
                and only the total says how close anybody is to going out (docs/rules.md §7).
              */}
              <span className="result__delta">
                {player.delta > 0 ? `+${player.delta}` : player.delta}
              </span>
              <span className="player__score">{player.scoreAfter} pts</span>
            </div>

            <div className="result__hand">
              <ul className="result__cards">
                {player.hand.map((card) => (
                  <li key={card.id}>
                    <PlayingCard card={card} />
                  </li>
                ))}
              </ul>
              {/* What the hand was worth — the number the whole call turned on. */}
              <span className="result__value">{player.handValue} in hand</span>
            </div>
          </li>
        ))}
      </ul>

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
