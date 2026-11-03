/**
 * What the session was refused, held up at the top of the screen rather than written into it
 * (spec #245).
 *
 * The error used to be a line in each screen's column, and on the table that line sat under
 * the player's own bar: the hand jumped up a row when it appeared and dropped back when it
 * went. So this layer is fixed to the viewport and takes no space in any layout — nothing a
 * player is looking at moves when a toast comes or goes.
 *
 * **Shaped for a list already**, though the session holds one error for now: each toast is
 * an id and the error it carries, and ✕ hands back the id. `App.tsx` adapts the single error
 * to that shape until the snapshot holds the list itself.
 *
 * The layer is inert to every tap and each toast is not, so the felt around a toast still
 * takes a tap meant for it.
 */

import type { GameError } from "@yaniv/shared";

interface ErrorToastsProps {
  /** Oldest first, so a toast already on screen never moves when another arrives below it. */
  toasts: readonly { id: number; error: GameError }[];
  onDismiss: (id: number) => void;
}

export function ErrorToasts({ toasts, onDismiss }: ErrorToastsProps) {
  return (
    <div className="toasts">
      {toasts.map(({ id, error }) => (
        <div key={id} className="toast" role="alert">
          <p className="toast__message">{error.message}</p>
          <button
            className="toast__dismiss"
            type="button"
            aria-label="Dismiss"
            onClick={() => onDismiss(id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
