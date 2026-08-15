/**
 * A panel over whatever screen opened it, and the three ways back out of it.
 *
 * Two things are asked behind one of these — what the room's settings are, and whether the
 * host means to close it — and the only reason they share a component is the part that is
 * not visible: a dialog has to be announced as one, has to take the focus, and has to be
 * dismissable by the backdrop, by a control and by Escape. Two copies of that contract is
 * two places for it to drift, and the half that drifts is the half nobody can see.
 *
 * Whether it is open belongs to whoever opened it. This draws a panel; it does not decide
 * that there is one, and there is deliberately no state here to get out of step with the
 * screen behind it.
 *
 * Fixed to the viewport rather than placed in the column, so it is the same panel in the
 * same place on a lobby, a table, a scored round and a finished match.
 */

import type { ReactNode } from "react";

interface ModalProps {
  /** Said at the top, and to a screen reader as the name of the dialog. */
  title: string;
  /** Everything the panel is for, controls included — the closing one especially. */
  children: ReactNode;
  /** The backdrop and Escape both land here. A control inside `children` may too. */
  onDismiss: () => void;
}

export function Modal({ title, children, onDismiss }: ModalProps) {
  return (
    /*
      Escape is caught here rather than on the window, because the key event reaches this
      element from whatever inside it has focus — and something inside it always does, since
      the panel's own dismissing control takes focus on open precisely so that it can.
    */
    <div
      className="modal"
      role="presentation"
      onClick={onDismiss}
      onKeyDown={(event) => {
        if (event.key === "Escape") onDismiss();
      }}
    >
      <div
        className="modal__panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // The backdrop's job is to close on a tap that misses the panel; a tap that hits
        // it has not missed.
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="modal__title">{title}</h2>
        {children}
      </div>
    </div>
  );
}
