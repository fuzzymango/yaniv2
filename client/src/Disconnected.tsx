/**
 * The screen for a session with no socket under it.
 *
 * Above every other screen rather than beside them, and the second one that is not a
 * function of `view.phase`: whatever position was last drawn is still on the client, but
 * none of it is true any more and none of its controls do anything. A player left tapping
 * at a table that has quietly stopped answering is the exact failure this ticket exists
 * for.
 *
 * It says the seat is waiting rather than that the match is over, because it is: the server
 * holds a room open through a drop, and the connection coming back claims the seat straight
 * back — see the `connect` handler in `session.ts`. What is being waited for is a *fresh*
 * connection, and the player is put back where it finds them. If the table did go while
 * they were away, they are told so then, on a screen that can say it.
 *
 * One screen for both ways there is no socket — one that went, and one that never arrived
 * — because they are the same screen to whoever is looking at it: nothing they tap will do
 * anything, and the only thing to do about either is wait. The words are chosen to be true
 * of both: from the main menu, where the player left off *is* the main menu.
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
          Trying to reach the server. You will pick up where you left off when the
          connection returns.
        </p>
        <p className="code__hint">Check your signal if this stays up.</p>
      </div>
    </main>
  );
}
