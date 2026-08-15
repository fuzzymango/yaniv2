/**
 * The host's way of ending a room: ask, then do it.
 *
 * The only thing that closes a room other than the game's own rules, and the only exit that
 * works mid-round — `exitToMenu` is refused there, for a hand and a turn order the round is
 * still being played against. A table that has gone quiet is exactly what it is for.
 *
 * Shown to the host alone, which is a courtesy and not the rule: the server answers anyone
 * else with `NOT_HOST` whatever a screen chose to draw. Every screen that has a room to
 * close carries one — the lobby, the table, a scored round, a finished match — because a
 * host who needs to end a game should not have to find the one screen that offers it.
 *
 * Drawn two ways for the two kinds of furniture it lands in: an icon beside the settings on
 * the screens whose whole width is the game, and a full-width control in the row of them on
 * the screens that have one. One component either way, so the confirmation and the wording
 * cannot drift apart between screens.
 *
 * It asks first, and that is the difference from every other control in this client. A tap
 * that lands here ends the match for five other people and nothing brings it back — the one
 * place in this interface where the cost of a misplaced thumb is somebody else's game.
 * Whether the panel is open is this component's own state, as the settings dialog's is: no
 * arriving view can contradict it, and nothing on the wire knows or cares that somebody is
 * looking at it.
 */

import { useState } from "react";

/** Ending it, in the glyph everything else uses for that: the power symbol. */
function PowerIcon() {
  return (
    <svg
      className="topbar__icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3v9" />
      <path d="M6.5 7a8 8 0 1 0 11 0" />
    </svg>
  );
}

const TITLE = "Close the room";

interface CloseRoomProps {
  /**
   * Where it is being drawn: `icon` for the bar every in-match screen carries, `button`
   * for a row of controls. What it does is the same either way.
   */
  variant: "icon" | "button";
  busy: boolean;
  onClose: () => void;
}

export function CloseRoom({ variant, busy, onClose }: CloseRoomProps) {
  const [asking, setAsking] = useState(false);

  return (
    <>
      {variant === "icon" ? (
        <button
          className="topbar__button topbar__button--danger"
          type="button"
          aria-label={TITLE}
          aria-haspopup="dialog"
          aria-expanded={asking}
          // Not locked on `busy`: opening the question asks nothing of the server, and a
          // host whose last action is still in flight is exactly one who may want this.
          onClick={() => setAsking(true)}
        >
          <PowerIcon />
        </button>
      ) : (
        <button
          className="button"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={asking}
          onClick={() => setAsking(true)}
        >
          {TITLE}
        </button>
      )}

      {asking && (
        // The same panel as the settings, closed the same three ways — the backdrop, the
        // control, and Escape. Escape is caught here rather than on the window because the
        // key event reaches this element from whatever inside it has focus.
        <div
          className="modal"
          role="presentation"
          onClick={() => setAsking(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setAsking(false);
          }}
        >
          <div
            className="modal__panel"
            role="dialog"
            aria-modal="true"
            aria-label={TITLE}
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="modal__title">{TITLE}?</h2>
            {/* What it costs, and to whom — the only reason to ask at all. */}
            <p className="modal__hint">
              Everyone here goes back to the main menu, and the match ends. This cannot be
              undone.
            </p>

            <button
              className="button button--danger"
              type="button"
              disabled={busy}
              onClick={onClose}
            >
              {TITLE}
            </button>
            {/*
              Focused on open, so the panel opens on the way *out* of it: the answer a
              stray tap or an idle Enter should give is "no".
            */}
            <button
              className="button"
              type="button"
              autoFocus
              onClick={() => setAsking(false)}
            >
              Keep playing
            </button>
          </div>
        </div>
      )}
    </>
  );
}
