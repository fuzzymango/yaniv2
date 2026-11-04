/**
 * What the session has to tell the player, held up at the top of the screen rather than
 * written into it (spec #245).
 *
 * The error used to be a line in each screen's column, and on the table that line sat under
 * the player's own bar: the hand jumped up a row when it appeared and dropped back when it
 * went. So this layer is fixed to the viewport and takes no space in any layout — nothing a
 * player is looking at moves when a toast comes or goes.
 *
 * The session's list, drawn as it stands: each toast an id, a tone and what it says, ✕
 * handing back the id, and ✕ the only way one goes (`dismissToast`). A refusal is drawn red
 * and news green (`toast--news`).
 *
 * The layer is inert to every tap and each toast is not, so the felt around a toast still
 * takes a tap meant for it.
 */

import type { Toast } from "../session.ts";

interface ToastsProps {
  /** Oldest first, so a toast already on screen never moves when another arrives below it. */
  toasts: readonly Toast[];
  onDismiss: (id: number) => void;
}

export function Toasts({ toasts, onDismiss }: ToastsProps) {
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={toast.tone === "news" ? "toast toast--news" : "toast"}
          role="alert"
        >
          <p className="toast__message">
            {toast.tone === "news" ? toast.message : toast.error.message}
          </p>
          <button
            className="toast__dismiss"
            type="button"
            aria-label="Dismiss"
            onClick={() => onDismiss(toast.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
