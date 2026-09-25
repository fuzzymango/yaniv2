/**
 * The screen before any room exists: who you are, and the two ways into a room.
 *
 * The one screen that renders without a view, which is why it takes none. The name and
 * the code are the player's typing and nothing more — they belong to this field until
 * an intent is called with them, so they live here rather than in the session.
 *
 * Neither button decides anything: an unusable name is refused by the session core and
 * a bad code by the server, and both come back the same way, as an error to show. This
 * file only says what happened.
 *
 * It is also where a player lands when a room goes away underneath them, which is what
 * the notice is for — news about the room they were in rather than a refusal of anything
 * they did here.
 *
 * **And it is the one screen where a player signs in or out** (#174): an account binds
 * before any room exists, so identity is asked about here and nowhere else, and the two
 * doors into a room are exactly as long as they were either way.
 *
 * - **Signed out**, Google's button sits at the top of the form, above the name — and a
 *   guest is told nothing else: no benefit copy, no nagging, no "or continue as a guest".
 *   Playing without an account is not the consolation path. Where Google's script cannot
 *   load there is no button at all, and the menu is what it was before accounts existed.
 * - **Signed in**, the name field is gone — a room is entered under the account's name,
 *   which the session core sends in place of anything typed — and in its place is who
 *   they are playing as, with a way to change it. Sign out is a small control in the
 *   corner, here and on no other screen: it forgets the seat as well as the account
 *   (docs/adr/0020), and at a table that would be the seat being sat in.
 *
 * The prompt belongs in the flow and the state in the chrome, which is why the two are
 * drawn in different places rather than one control that changes its label.
 */

import { useState } from "react";
import type { GameError } from "@yaniv/shared";
import type { AccountStanding } from "../session.ts";
import { GoogleButton } from "./GoogleButton.tsx";
import { NameDialog } from "./NameDialog.tsx";

interface MainMenuProps {
  account: AccountStanding;
  error: GameError | null;
  notice: string | null;
  busy: boolean;
  onCreate: (playerName: string) => void;
  onJoin: (roomCode: string, playerName: string) => void;
  onSignIn: (idToken: string) => void;
  onCreateAccount: (displayName: string) => void;
  onCancelSignIn: () => void;
  onRenameAccount: (displayName: string) => void;
  onClearError: () => void;
  onSignOut: () => void;
}

export function MainMenu({
  account,
  error,
  notice,
  busy,
  onCreate,
  onJoin,
  onSignIn,
  onCreateAccount,
  onCancelSignIn,
  onRenameAccount,
  onClearError,
  onSignOut,
}: MainMenuProps) {
  const [name, setName] = useState("");
  const [roomCode, setRoomCode] = useState("");

  /**
   * The standing a rename was opened over, and the panel is open for as long as that is
   * still the standing on the screen. The session core replaces it when a rename lands —
   * even to the same name — and keeps it when one is refused (pinned in the session
   * suite), so the panel closes on the answer that means "done" and stays up to show the
   * one that means "not that", with no effect watching for either. Signing out or being
   * signed out replaces it too, which closes a panel with no account left to rename.
   *
   * The refusal on screen is put down on the way in and on the way out, as "Not now" does
   * for the confirm step: one left over from the menu is no answer about a name, and one
   * the panel was showing is about a question nobody is asking once it has closed.
   */
  const [renamingFrom, setRenamingFrom] = useState<AccountStanding | null>(null);

  /**
   * Nothing to join until a code has been typed, so joining is inert until then rather
   * than sending a blank code and reporting back that no room has that code — which is
   * true, and no answer at all to a player who has not typed one. The name field shares
   * this form, so Enter from it lands here too.
   */
  const canJoin = roomCode.trim().length > 0;

  const dialog =
    account.status === "nameNeeded" ? (
      <NameDialog
        confirming
        suggestedName={account.suggestedName}
        error={error}
        busy={busy}
        onSave={onCreateAccount}
        onDismiss={onCancelSignIn}
      />
    ) : account.status === "signedIn" && renamingFrom === account ? (
      <NameDialog
        confirming={false}
        suggestedName={account.account.displayName}
        error={error}
        busy={busy}
        onSave={onRenameAccount}
        onDismiss={() => {
          onClearError();
          setRenamingFrom(null);
        }}
      />
    ) : null;

  return (
    <main className="screen menu">
      {account.status === "signedIn" && (
        <button
          className="menu__sign-out"
          type="button"
          onClick={onSignOut}
          disabled={busy}
        >
          Sign out
        </button>
      )}

      <h1 className="menu__title">Yaniv</h1>

      {/*
        Above the form rather than below it, because it explains why this screen is the
        one in front of them — and it is read before anything is typed, not after.
      */}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <form
        className="menu__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canJoin) onJoin(roomCode, name);
        }}
      >
        {account.status === "signedIn" ? (
          <div className="menu__identity">
            <p className="menu__playing-as">
              Playing as <strong className="menu__name">{account.account.displayName}</strong>
            </p>
            <button
              className="button"
              type="button"
              aria-haspopup="dialog"
              onClick={() => {
                onClearError();
                setRenamingFrom(account);
              }}
              disabled={busy}
            >
              Change name
            </button>
          </div>
        ) : (
          <>
            {/*
              Still mounted while a first sign-in's name is being confirmed, so "Not now"
              lands back on the same button rather than on a slot waiting for it again.
            */}
            <GoogleButton onCredential={onSignIn} />
            <label className="field">
              <span className="field__label">Your name</span>
              <input
                className="field__input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="nickname"
                enterKeyHint="next"
                disabled={busy}
              />
            </label>
          </>
        )}

        <button
          className="button button--primary"
          type="button"
          onClick={() => onCreate(name)}
          disabled={busy}
        >
          Create a room
        </button>

        <p className="menu__or">or join one</p>

        <label className="field">
          <span className="field__label">Room code</span>
          <input
            className="field__input field__input--code"
            value={roomCode}
            onChange={(event) => setRoomCode(event.target.value)}
            // Typed off a code somebody read aloud, so case is not the player's problem:
            // the keyboard is asked for capitals and the session normalises regardless.
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            enterKeyHint="go"
            disabled={busy}
          />
        </label>

        <button className="button" type="submit" disabled={busy || !canJoin}>
          Join
        </button>
      </form>

      {/* The panel's while it is open: see `NameDialog.tsx`. */}
      {error && dialog === null && (
        <p className="notice notice--error" role="alert">
          {error.message}
        </p>
      )}

      {dialog}
    </main>
  );
}
