/**
 * A panel over whatever screen opened it, and the three ways back out of it.
 *
 * Three things are held up behind one of these — what the room's settings are, whether a
 * player means to leave the table, and the match's scorecard — and the only reason they
 * share a component is the part that is not visible: a dialog has to be announced as one,
 * has to take the focus, and has to be dismissable by the backdrop, by a control and by
 * Escape. Two copies of that contract is two places for it to drift, and the half that
 * drifts is the half nobody can see.
 *
 * The scorecard's dismissing control lives *outside* the panel, in the bar it was opened
 * from, and that needs nothing here: dismissal has always been a callback, so a control
 * anywhere on the screen can be the one that calls it.
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
  /**
   * The name of the dialog to a screen reader, always — a panel that announces itself as
   * one has to be announced as something.
   */
  title: string;
  /**
   * Whether that name is also drawn at the top of the panel. Default yes: a question asked
   * behind one of these usually needs its heading. The scorecard is the exception — it is a
   * sheet of paper whose names and numbers are the whole document, and a caption over it
   * would be the panel talking about itself.
   */
  showTitle?: boolean;
  /** Everything the panel is for, controls included. */
  children: ReactNode;
  /** The backdrop and Escape both land here. A control inside `children` may too. */
  onDismiss: () => void;
}

export function Modal({ title, showTitle = true, children, onDismiss }: ModalProps) {
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
        {showTitle && <h2 className="modal__title">{title}</h2>}
        {children}
      </div>
    </div>
  );
}
