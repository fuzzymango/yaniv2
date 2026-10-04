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
 *   which the session core sends in place of anything typed — and in its place is a
 *   greeting, "Welcome <name>", plain text rather than a second way into anything. A
 *   person icon in the corner opens the **profile** (`ProfileDialog`, #228), where the
 *   name is changed (#229), the custom calls are chosen (#237) and the player signs out
 *   (#230), and nowhere else. Signing out
 *   forgets the seat as well as the account (docs/adr/0020), and at a table that would be
 *   the seat being sat in — which is why it sits behind a panel this screen alone opens.
 *
 * The prompt belongs in the flow and the state in the chrome, which is why the two are
 * drawn in different places rather than one control that changes its label.
 */

import { useState } from "react";
import type { Call, GameError, Stats } from "@yaniv/shared";
import type { AccountStanding } from "../session.ts";
import { GoogleButton } from "./GoogleButton.tsx";
import { NameDialog } from "./NameDialog.tsx";
import { ProfileDialog } from "./ProfileDialog.tsx";

interface MainMenuProps {
  account: AccountStanding;
  stats: Stats | null;
  error: GameError | null;
  notice: string | null;
  busy: boolean;
  onCreate: (playerName: string) => void;
  onJoin: (roomCode: string, playerName: string) => void;
  onSignIn: (idToken: string) => void;
  onCreateAccount: (displayName: string) => void;
  onCancelSignIn: () => void;
  onRenameAccount: (displayName: string) => void;
  onSetCustomCall: (call: Call, text: string) => void;
  onClearError: () => void;
  onSignOut: () => void;
  onLoadStats: () => void;
}

export function MainMenu({
  account,
  stats,
  error,
  notice,
  busy,
  onCreate,
  onJoin,
  onSignIn,
  onCreateAccount,
  onCancelSignIn,
  onRenameAccount,
  onSetCustomCall,
  onClearError,
  onSignOut,
  onLoadStats,
}: MainMenuProps) {
  const [name, setName] = useState("");
  const [roomCode, setRoomCode] = useState("");

  /**
   * Whether the profile is up — held here rather than in it, because while it is the menu
   * shows no error (see `ProfileDialog.tsx`). Put down the moment there is no account to
   * show, as an edit refused for a lapsed session leaves, so the next sign-in does not
   * land with it already open: state adjusted in render, before anything is drawn from it.
   */
  const [profileOpen, setProfileOpen] = useState(false);
  if (profileOpen && account.status !== "signedIn") setProfileOpen(false);

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
        suggestedName={account.suggestedName}
        error={error}
        busy={busy}
        onSave={onCreateAccount}
        onDismiss={onCancelSignIn}
      />
    ) : null;

  return (
    <main className="screen menu">
      {account.status === "signedIn" && (
        <div className="menu__corner">
          <ProfileDialog
            standing={account}
            stats={stats}
            error={error}
            busy={busy}
            open={profileOpen}
            onOpenChange={setProfileOpen}
            onLoadStats={onLoadStats}
            onRename={onRenameAccount}
            onSetCustomCall={onSetCustomCall}
            onClearError={onClearError}
            onSignOut={onSignOut}
          />
        </div>
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
            <p className="menu__welcome">
              Welcome <strong className="menu__name">{account.account.displayName}</strong>
            </p>
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

      {/* The panel's while one is open: see `NameDialog.tsx` and `ProfileDialog.tsx`. */}
      {error && dialog === null && !profileOpen && (
        <p className="notice notice--error" role="alert">
          {error.message}
        </p>
      )}

      {dialog}
    </main>
  );
}
