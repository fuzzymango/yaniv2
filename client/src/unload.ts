/**
 * The one thing this client asks the browser for: don't close that tab yet.
 *
 * A reload or a closed tab drops the socket. The server holds the seat open for whoever
 * dropped, but this client cannot yet present the token that would claim it back (issue
 * #65), so the gesture still costs the player the hand they were in the middle of — and
 * they are asked whether they meant it.
 *
 * Only while a round is live. The positions where leaving is *allowed* — the main menu,
 * the lobby, a finished match — have a control on the screen that does exactly that, and a
 * page that argued about it there would be crying wolf at the two moments it most needs to
 * be believed.
 *
 * The target is injected rather than reached for, which is what lets `node:test` drive this
 * with no browser: the guard is the last thing in the client that touches a global, and it
 * touches it only where `main.tsx` hands it one. The same reason the session takes its
 * socket rather than opening one.
 */

import type { Session, SessionSnapshot } from "./session.ts";

/**
 * The tab closing, in the only two terms this cares about. Narrower than the browser's
 * `BeforeUnloadEvent` on purpose: a test can build one, and a real one satisfies it.
 */
export interface UnloadEvent {
  preventDefault: () => void;
  /**
   * The pre-standard way of asking the same question, which browsers older than the
   * `preventDefault` rule still read. Whatever is put here is never shown — every browser
   * insists on its own wording — so it is a flag written in the shape of a message.
   */
  returnValue: unknown;
}

/** As much of `window` as the guard uses, so the guard can be given something else. */
export interface UnloadTarget {
  addEventListener: (
    type: "beforeunload",
    listener: (event: UnloadEvent) => void,
  ) => void;
  removeEventListener: (
    type: "beforeunload",
    listener: (event: UnloadEvent) => void,
  ) => void;
}

/**
 * The read half of a session. The guard watches and never acts — taking only this says so
 * in the type, and spares a test standing up every intent to prove it.
 */
export type SessionReader = Pick<Session, "subscribe" | "getSnapshot">;

/**
 * Whether walking away now would cost the table a round it is in the middle of.
 *
 * `playing` and one just scored with more still to deal, and not `gameEnd` — which does
 * still carry a round (see "Lobby vs. active" in CONTEXT.md) but has nothing left to lose:
 * the match is over and leaving is a control on that very screen. The lobby is out for the
 * same reason.
 *
 * And not while the socket is gone. The room a dropped connection was in was destroyed at
 * the moment it dropped, so the position still on the screen is a match that is already
 * lost — arguing about closing the tab on it is the crying wolf this file exists to avoid.
 */
function wouldEndALiveRound({ view, connected }: SessionSnapshot): boolean {
  return (
    connected && view !== null && (view.phase === "playing" || view.phase === "roundEnd")
  );
}

/**
 * Keep the warning in step with the position, for as long as the returned teardown is
 * uncalled.
 *
 * Registered and unregistered rather than always listening and deciding when it fires,
 * because the two are not the same to a browser: a page with a `beforeunload` listener is
 * held out of the back/forward cache whether the listener would do anything or not.
 */
export function guardUnload(session: SessionReader, target: UnloadTarget): () => void {
  let warning = false;

  const warn = (event: UnloadEvent): void => {
    event.preventDefault();
    event.returnValue = true;
  };

  const sync = (): void => {
    const wanted = wouldEndALiveRound(session.getSnapshot());
    if (wanted === warning) return;
    if (wanted) target.addEventListener("beforeunload", warn);
    else target.removeEventListener("beforeunload", warn);
    warning = wanted;
  };

  const unsubscribe = session.subscribe(sync);
  // A guard registered mid-match — a hot reload in development, say — has to catch up with
  // where the session already is, since nothing will publish again until somebody moves.
  sync();

  return () => {
    unsubscribe();
    if (warning) {
      target.removeEventListener("beforeunload", warn);
      warning = false;
    }
  };
}
