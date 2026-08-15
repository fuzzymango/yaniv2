/**
 * How a player gets out of a room, which is a different thing depending on who they are.
 *
 * A guest **leaves**: their seat is freed and the room plays on for whoever remains. The
 * host **closes**: the room ends for everybody, and it is the only thing that ends one
 * early — a dropped connection no longer does (see "Close room" in CONTEXT.md). That split
 * is not the caller's to choose and never was; before this the host's "leave" quietly
 * closed the room, and all that has changed is that it now says so.
 *
 * Shown to the host alone, which is a courtesy and not the rule: the server answers anyone
 * else's `closeRoom` with `NOT_HOST` whatever a screen chose to draw.
 *
 * Two shapes for the two kinds of furniture. `CloseRoomIcon` goes in the bar every in-match
 * screen carries, beside the settings, because a table and a scored round are all game and
 * have no row of controls to put a button in; `WayOut` is that row, in the lobby and at a
 * finished match. One file either way, so the wording and the confirmation cannot drift
 * apart between screens the way two copies of them would.
 *
 * Closing asks first, and it is the only control in this client that does. A tap that lands
 * here ends the match for everyone else and nothing brings it back — the one place in this
 * interface where a misplaced thumb costs somebody else their game.
 */

import { useState } from "react";
import { Modal } from "./Modal.tsx";

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

const CLOSE = "Close the room";

/**
 * The question itself, asked the same way from both triggers.
 *
 * `busy` locks the answer and not the question: opening it asks nothing of the server, and
 * a host whose last action is still in flight is exactly the one who may want this.
 */
function ConfirmClose({
  busy,
  onConfirm,
  onDismiss,
}: {
  busy: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  return (
    <Modal title={`${CLOSE}?`} onDismiss={onDismiss}>
      {/* What it costs, and to whom — the only reason to ask at all. */}
      <p className="modal__hint">
        Everyone here goes back to the main menu, and the match ends. This cannot be undone.
      </p>

      <button className="button button--danger" type="button" disabled={busy} onClick={onConfirm}>
        {CLOSE}
      </button>
      {/*
        Focused on open, so the panel opens on the way *out* of itself: the answer a stray
        tap or an idle Enter should give is "no".
      */}
      <button className="button" type="button" autoFocus onClick={onDismiss}>
        Keep playing
      </button>
    </Modal>
  );
}

interface CloseProps {
  busy: boolean;
  onClose: () => void;
}

/** The host's control where a screen is all game: an icon beside the settings. */
export function CloseRoomIcon({ busy, onClose }: CloseProps) {
  const [asking, setAsking] = useState(false);

  return (
    <>
      <button
        className="topbar__button topbar__button--danger"
        type="button"
        aria-label={CLOSE}
        aria-haspopup="dialog"
        aria-expanded={asking}
        onClick={() => setAsking(true)}
      >
        <PowerIcon />
      </button>

      {asking && (
        <ConfirmClose busy={busy} onConfirm={onClose} onDismiss={() => setAsking(false)} />
      )}
    </>
  );
}

/** The same control where a screen has a row of them: the lobby, and a finished match. */
function CloseRoomButton({ busy, onClose }: CloseProps) {
  const [asking, setAsking] = useState(false);

  return (
    <>
      <button
        className="button"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={asking}
        onClick={() => setAsking(true)}
      >
        {CLOSE}
      </button>

      {asking && (
        <ConfirmClose busy={busy} onConfirm={onClose} onDismiss={() => setAsking(false)} />
      )}
    </>
  );
}

interface WayOutProps {
  /** Whose screen this is, and therefore which of the two ways out it offers. */
  isHost: boolean;
  busy: boolean;
  onExit: () => void;
  onCloseRoom: () => void;
}

export function WayOut({ isHost, busy, onExit, onCloseRoom }: WayOutProps) {
  if (isHost) return <CloseRoomButton busy={busy} onClose={onCloseRoom} />;

  // Promises nothing about the rest of the table, because a guest leaving costs it
  // nothing: the room plays on without them.
  return (
    <button className="button" type="button" onClick={onExit} disabled={busy}>
      Leave the room
    </button>
  );
}
