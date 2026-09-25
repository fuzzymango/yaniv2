/**
 * The name an account goes by, asked for over the main menu — once when the account is
 * made, and again whenever its holder wants to change it (#174 §4).
 *
 * One panel for both, because it is one question: what should the table call you? The
 * difference between them is the way out. **Confirming** a first sign-in's name cannot be
 * dismissed by Escape or the backdrop — there is no account yet for a stray tap to fall back
 * to, and the sign-in Google just vouched for would go with it — so it carries an explicit
 * "Not now", which drops the player back at the menu as the guest they were. **Renaming** is
 * as dismissable as every other panel here, there being an account either way.
 *
 * Prefilled — with Google's name the first time, the account's own after — and the player's
 * to change before anything is saved: a real name is not put in front of strangers at a card
 * table without their say-so. Names are never unique (see "Display name" in CONTEXT.md), so
 * there is no "already taken" to be told; the only refusal is the shared 1–20 rule.
 *
 * **The panel shows the session's `error` while it is open**, and the menu behind it shows
 * none: a refused name is about what was typed here, and one message belongs in the one
 * place the player is looking — the trick `App.tsx` uses for `GameEnd`. Only once this panel
 * has sent something, though, so a refusal left over from the menu (a code nobody is behind)
 * is not read as an answer about a name.
 *
 * The draft is this component's own, on the settings editor's precedent: a name half-typed
 * is no use outside the panel holding it.
 */

import { useState } from "react";
import type { GameError } from "@yaniv/shared";
import { Modal } from "../shared/Modal.tsx";

interface NameDialogProps {
  /**
   * Confirming the name of an account about to be made, rather than renaming one: the
   * panel's wording, and whether anything but its own control closes it.
   */
  confirming: boolean;
  /** What the field starts out holding. */
  suggestedName: string;
  error: GameError | null;
  busy: boolean;
  onSave: (displayName: string) => void;
  /** "Not now" when confirming, "Cancel" when renaming — and the backdrop and Escape too. */
  onDismiss: () => void;
}

export function NameDialog({
  confirming,
  suggestedName,
  error,
  busy,
  onSave,
  onDismiss,
}: NameDialogProps) {
  const [name, setName] = useState(suggestedName);
  const [sent, setSent] = useState(false);

  return (
    <Modal
      title={confirming ? "Choose your name" : "Change your name"}
      dismissible={!confirming}
      onDismiss={onDismiss}
    >
      <p className="modal__hint">
        {confirming
          ? "The name other players see at the table. You can change it later."
          : "The name other players see at the table, from your next room on."}
      </p>

      <form
        className="modal__form"
        onSubmit={(event) => {
          event.preventDefault();
          setSent(true);
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
            // Focused on open, so there is somewhere inside the panel for Escape to be
            // caught — and because typing is the one thing the panel is for.
            autoFocus
            disabled={busy}
          />
        </label>

        <div className="modal__choice">
          <button className="button" type="button" onClick={onDismiss} disabled={busy}>
            {confirming ? "Not now" : "Cancel"}
          </button>
          <button className="button button--primary" type="submit" disabled={busy}>
            {confirming ? "Continue" : "Save"}
          </button>
        </div>
      </form>

      {sent && error && (
        <p className="notice notice--error" role="alert">
          {error.message}
        </p>
      )}
    </Modal>
  );
}
