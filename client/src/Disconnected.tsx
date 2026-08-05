/**
 * The screen for a session with no socket under it.
 *
 * Above every other screen rather than beside them, and the second one that is not a
 * function of `view.phase`: whatever position was last drawn is still on the client, but
 * none of it is true any more and none of its controls do anything. A player left tapping
 * at a table that has quietly stopped answering is the exact failure this ticket exists
 * for.
 *
 * It says the match is over rather than holding out hope for it, because it is: the server
 * destroys a room the moment a connection in it drops, and reconnect is the next piece of
 * work rather than this one (ADR-0004). What is being waited for is a *fresh* connection,
 * which lands the player back at the main menu — see the `connect` handler in `session.ts`.
 *
 * One screen for both ways there is no socket — one that went, and one that never arrived
 * — because they are the same screen to whoever is looking at it: nothing they tap will do
 * anything, and the only thing to do about either is wait. The words are chosen to be true
 * of both.
 *
 * There is no retry control, deliberately. socket.io is already trying, on its own backoff,
 * and a button that did the same thing on demand would mostly be a way of asking a player
 * to fix something they cannot.
 */

export function Disconnected() {
  return (
    <main className="screen dropped">
      {/*
        `alert` rather than `status`: this interrupts whatever the player was doing, which
        is the one time a screen reader should be interrupted too.
      */}
      <div className="dropped__body" role="alert">
        <h1 className="dropped__title">No connection</h1>
        <p className="dropped__detail">
          Trying to reach the server. Any match you were in has ended — you will be back at
          the main menu when the connection returns.
        </p>
        <p className="code__hint">Check your signal if this stays up.</p>
      </div>
    </main>
  );
}
