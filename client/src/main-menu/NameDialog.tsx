/**
 * The name an account goes by, asked for over the main menu once, as the account is made
 * (#174 §4). Changing it later is the profile's (`ProfileDialog`, #229).
 *
 * It cannot be dismissed by Escape or the backdrop — there is no account yet for a stray tap
 * to fall back to, and the sign-in Google just vouched for would go with it — so it carries
 * an explicit "Not now", which drops the player back at the menu as the guest they were.
 *
 * Prefilled with Google's name, and the player's to change before anything is saved: a real
 * name is not put in front of strangers at a card table without their say-so. Names are never
 * unique (see "Display name" in CONTEXT.md), so there is no "already taken" to be told; the
 * only refusal is the shared display-name rule.
 *
 * **The panel shows the session's `error` while it is open**, and the menu behind it shows
 * none: a refused name is about what was typed here, and one message belongs in the one
 * place the player is looking — the trick `App.tsx` uses for `GameEnd`. Nothing left over
 * from the menu is here to be misread as an answer about a name: the session puts it down as
 * the panel opens, `signIn` sending.
 *
 * The draft is this component's own, on the settings editor's precedent: a name half-typed
 * is no use outside the panel holding it.
 */

import { useState } from "react";
import type { GameError } from "@yaniv/shared";
import { Modal } from "../shared/Modal.tsx";

interface NameDialogProps {
  /** What the field starts out holding. */
  suggestedName: string;
  error: GameError | null;
  busy: boolean;
  onSave: (displayName: string) => void;
  /** "Not now": the player stays the guest they were. */
  onDismiss: () => void;
}

export function NameDialog({
  suggestedName,
  error,
  busy,
  onSave,
  onDismiss,
}: NameDialogProps) {
  const [name, setName] = useState(suggestedName);

  return (
    <Modal title="Choose your name" dismissible={false} onDismiss={onDismiss}>
      <p className="modal__hint">
        The name other players see at the table. You can change it later.
      </p>

      <form
        className="modal__form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(name);
        }}
      >
        <label className="field">
          <span className="field__label">Your name</span>
          <input
            className="field__input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="nickname"
            enterKeyHint="done"
            // Focused on open, because typing is the one thing the panel is for.
            autoFocus
            disabled={busy}
          />
        </label>

        <div className="modal__choice">
          <button className="button" type="button" onClick={onDismiss} disabled={busy}>
            Not now
          </button>
          <button className="button button--primary" type="submit" disabled={busy}>
            Continue
          </button>
        </div>
      </form>

      {error && (
        <p className="notice notice--error" role="alert">
          {error.message}
        </p>
      )}
    </Modal>
  );
}
