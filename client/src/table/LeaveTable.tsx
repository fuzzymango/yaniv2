/**
 * The way out of a round being played, which is the one exit that costs the player
 * something (issue #147).
 *
 * Leaving is allowed in every phase now, and everywhere else it is the plain `WayOut`:
 * from the lobby nothing has been dealt, and at `gameEnd` the match is already over, so
 * the button acts on the tap and asks nobody anything. Mid-match it is different in one
 * respect that matters — the leaver is out of *this* match for good, with no way back into
 * it — so this asks first. It is the same rule `WayOut` states in the negative: nothing is
 * asked before an action that costs nothing, and this one costs the person taking it their
 * match.
 *
 * Nobody else pays for it either way (docs/adr/0012), which is why the question is about
 * the leaver alone and says nothing about the table they are getting up from.
 *
 * An icon in the same bar as the settings, and for the same reason: getting up mid-hand is
 * rare, and a control that is there to be found rather than noticed is what a screen with a
 * turn to take has room for. One of them for everybody looking at the table, player and
 * watcher alike — the bar where a watcher's hand would be carried the only way out until
 * this, and a second button saying the same thing lower down the same screen would be two
 * answers to one tap.
 *
 * Whether the panel is open is this component's own, exactly as `SettingsDialog`'s is: no
 * arriving view knows or cares that somebody is looking at a question.
 */

import { useState } from "react";
import { Modal } from "../shared/Modal.tsx";
import { WayOut } from "../shared/WayOut.tsx";

const TITLE = "Leave the match?";

/**
 * Drawn rather than loaded, like every other icon here: a door with an arrow going out of
 * it. `aria-hidden`, because the button around it already says what it is in words.
 */
function ExitIcon() {
  return (
    <svg
      className="topbar__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M14 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h8" />
      <path d="M17 8l4 4-4 4" />
      <line x1="21" y1="12" x2="10" y2="12" />
    </svg>
  );
}

interface LeaveTableProps {
  busy: boolean;
  onExit: () => void;
}

export function LeaveTable({ busy, onExit }: LeaveTableProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="topbar__button"
        type="button"
        aria-label="Leave the match"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <ExitIcon />
      </button>

      {open && (
        <Modal title={TITLE} onDismiss={() => setOpen(false)}>
          {/* What it costs, in the one sentence that is true whichever phase this is. */}
          <p className="modal__hint">
            Your seat goes with you: the rest of this match is played without you, and there
            is no way back into it.
          </p>

          <div className="modal__choice">
            {/* Focused on open, so Escape has somewhere inside the panel to be caught. */}
            <button
              className="button"
              type="button"
              autoFocus
              onClick={() => setOpen(false)}
            >
              Stay
            </button>
            {/*
              The same button every other screen's way out is, word for word, because it is
              the same action: all this adds is the question in front of it.
            */}
            <WayOut busy={busy} onExit={onExit} />
          </div>
        </Modal>
      )}
    </>
  );
}
