/**
 * The screen before any room exists: a name, and the two ways into a room.
 *
 * The one screen that renders without a view, which is why it takes none. The name and
 * the code are the player's typing and nothing more — they belong to this field until
 * an intent is called with them, so they live here rather than in the session.
 *
 * Neither button decides anything: an empty name is refused by the session core and a
 * bad code by the server, and both come back the same way, as an error to show. This
 * file only says what happened.
 */

import { useState } from "react";
import type { GameError } from "@yaniv/shared";

interface MainMenuProps {
  error: GameError | null;
  busy: boolean;
  onCreate: (playerName: string) => void;
  onJoin: (roomCode: string, playerName: string) => void;
}

export function MainMenu({ error, busy, onCreate, onJoin }: MainMenuProps) {
  const [name, setName] = useState("");
  const [roomCode, setRoomCode] = useState("");

  /**
   * Nothing to join until a code has been typed, so joining is inert until then rather
   * than sending a blank code and reporting back that no room has that code — which is
   * true, and no answer at all to a player who has not typed one. The name field shares
   * this form, so Enter from it lands here too.
   */
  const canJoin = roomCode.trim().length > 0;

  return (
    <main className="screen menu">
      <h1 className="menu__title">Yaniv</h1>

      <form
        className="menu__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canJoin) onJoin(roomCode, name);
        }}
      >
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

      {error && (
        <p className="notice notice--error" role="alert">
          {error.message}
        </p>
      )}
    </main>
  );
}
