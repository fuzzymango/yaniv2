/**
 * The room before the cards come out: its code, who is in it, and the two things left to
 * do — start, or leave.
 *
 * The first screen that is a function of `view.phase`. There is no route behind it and no
 * URL to reach it by; a player is looking at the lobby because the server says the room is
 * in it. See docs/adr/0004.
 *
 * Nothing here decides anything. The host marker and the start control are display: who
 * may actually start is the server's call, and it answers anyone else with `NOT_HOST`.
 * Showing the control to the host alone spares a guest hunting for a button that was never
 * theirs — it is not what enforces the rule.
 */

import type { GameError, PlayerGameView } from "@yaniv/shared";

interface LobbyProps {
  view: PlayerGameView;
  error: GameError | null;
  busy: boolean;
  onStart: () => void;
  onExit: () => void;
}

export function Lobby({ view, error, busy, onStart, onExit }: LobbyProps) {
  const isHost = view.hostId === view.you.id;

  /**
   * Seating order, so the table reads the same way round on everybody's screen. Ordered
   * by `turnOrder` rather than listed from it, so every row is a player the view actually
   * carries — there is no id here that could be rendered raw for want of a name.
   */
  const seats = [view.you, ...view.opponents].sort(
    (a, b) => view.turnOrder.indexOf(a.id) - view.turnOrder.indexOf(b.id),
  );

  return (
    <main className="screen lobby">
      <header className="code">
        <p className="code__label">Room code</p>
        {/*
          Letter-spaced in CSS rather than run together: these are four unrelated
          characters, read out one at a time and not pronounced as a word.
        */}
        <p className="code__value">{view.roomCode}</p>
        <p className="code__hint">Read it out to whoever is playing with you.</p>
      </header>

      <ul className="seats">
        {seats.map((seat) => (
          <li className="seat" key={seat.id}>
            <span className="seat__name">{seat.name}</span>
            {/*
              "you" can only be decided here — it depends on whose screen this is, which
              is why it is never stored or sent over the wire.
            */}
            {seat.id === view.you.id && <span className="seat__mark">you</span>}
            {seat.id === view.hostId && <span className="seat__mark">host</span>}
          </li>
        ))}
      </ul>

      <div className="lobby__actions">
        {isHost ? (
          <button
            className="button button--primary"
            type="button"
            onClick={onStart}
            disabled={busy}
          >
            Start the match
          </button>
        ) : (
          // Its own class rather than `notice`, which carries news that has just
          // arrived. This is a standing fact about the screen.
          <p className="lobby__hint">The host starts the match.</p>
        )}

        {/*
          Promises neither outcome, because the caller does not choose it: a guest frees
          their own seat and the room plays on, the host closes it. See CONTEXT.md.
        */}
        <button className="button" type="button" onClick={onExit} disabled={busy}>
          Leave the room
        </button>
      </div>

      {error && (
        <p className="notice notice--error" role="alert">
          {error.message}
        </p>
      )}
    </main>
  );
}
