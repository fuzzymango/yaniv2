/**
 * The room's settings once they are locked: an icon in the corner, and the four values
 * behind it.
 *
 * Every in-match screen carries one — the table, a scored round, a finished match — and
 * none of them shows a setting anywhere else. That is deliberate: the table is a game to
 * play, not a room to read about, and a row of numbers standing over it would be four
 * things to look past on every turn. Behind an icon they cost a tap on the rare occasion
 * anybody wants them, which is usually once: "why is Yaniv not lighting up at seven?"
 *
 * The bar it sits in belongs to the screen rather than to this component, because the host
 * has a second icon in it — closing the room (`CloseRoom.tsx`).
 *
 * Read-only for everybody, host included, because by now they are read-only *for*
 * everybody: `startGame` locks them for the life of the room and `playAgain` never passes
 * back through the lobby to reopen them (docs/adr/0006). There is no control to show, so
 * this asks nothing of the session core and takes no `busy` — it publishes nothing and
 * cannot be refused.
 *
 * Whether the panel is open is state this component owns, as the lobby editor owns its
 * half-filled form. It is not a fact about the room and no arriving view can contradict
 * it: nothing on the wire knows or cares that somebody is looking at a panel, so keeping
 * it in the session core would put a purely local thing where server state lives. See
 * "The client's session core" in CLAUDE.md.
 */

import { useState } from "react";
import type { RoomSettings } from "@yaniv/shared";
import { SETTINGS_TITLE, SettingsValues } from "./SettingsValues.tsx";

/**
 * Drawn rather than loaded, like the cards: two sliders, which is what a settings icon
 * looks like everywhere else. `aria-hidden`, because the button around it already says
 * what it is in words.
 */
function SlidersIcon() {
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
      <line x1="3" y1="8" x2="21" y2="8" />
      <line x1="3" y1="16" x2="21" y2="16" />
      <circle cx="9" cy="8" r="2.5" />
      <circle cx="15" cy="16" r="2.5" />
    </svg>
  );
}

export function SettingsDialog({ settings }: { settings: RoomSettings }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="topbar__button"
        type="button"
        aria-label={SETTINGS_TITLE}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <SlidersIcon />
      </button>

      {open && (
        /*
          Closed by the backdrop, by the button, and by Escape — three ways out of a panel
          that was one tap in. Escape is caught here rather than on the window, because the
          key event reaches this element from whatever inside it has focus, and the close
          button takes focus on open precisely so that it does.
        */
        <div
          className="modal"
          role="presentation"
          onClick={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          <div
            className="modal__panel"
            role="dialog"
            aria-modal="true"
            aria-label={SETTINGS_TITLE}
            // The backdrop's job is to close on a tap that misses the panel; a tap that
            // hits it has not missed.
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="modal__title">{SETTINGS_TITLE}</h2>
            {/* Why there is nothing to change, said once, rather than four dead controls. */}
            <p className="modal__hint">Locked for the life of the room.</p>

            <SettingsValues settings={settings} botCount={settings.botCount} />

            <button
              className="button"
              type="button"
              autoFocus
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
