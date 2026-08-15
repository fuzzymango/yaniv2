/**
 * The room before the cards come out: its code, who is in it, and the two things left to
 * do — start, or leave.
 *
 * The first screen that is a function of `view.phase`. There is no route behind it and no
 * URL to reach it by; a player is looking at the lobby because the server says the room is
 * in it. See docs/adr/0004.
 *
 * Nothing here decides anything. The host marker and the start control are display: who
 * may actually start is the server's call, and it answers anyone else with `NOT_HOST`.
 * Showing the control to the host alone spares a guest hunting for a button that was never
 * theirs — it is not what enforces the rule.
 */

import type { GameError, PlayerGameView, RoomSettings } from "@yaniv/shared";
import { effectiveBotCount } from "@yaniv/shared";
import { SettingsEditor } from "./SettingsEditor.tsx";
import { SettingsPanel, SettingsValues } from "./SettingsValues.tsx";
import { WayOut } from "./WayOut.tsx";
import { bySeat } from "./seating.ts";

interface LobbyProps {
  view: PlayerGameView;
  error: GameError | null;
  busy: boolean;
  onStart: () => void;
  onUpdateSettings: (settings: RoomSettings) => void;
  onExit: () => void;
  /** End the room. The host's way out of this screen — see `WayOut.tsx`. */
  onCloseRoom: () => void;
}

export function Lobby({
  view,
  error,
  busy,
  onStart,
  onUpdateSettings,
  onExit,
  onCloseRoom,
}: LobbyProps) {
  const isHost = view.hostId === view.you.id;

  const seats = [view.you, ...view.opponents].sort(bySeat(view));

  /*
   * Everyone in a lobby is a person: bots are seated by `startGame` and not before, so
   * the roster is the human count the bot setting is read against (docs/adr/0006). This
   * is the one phase where that is true, and the only phase this screen renders in.
   */
  const humanCount = seats.length;

  return (
    <main className="screen lobby">
      <header className="code">
        <p className="code__label">Room code</p>
        {/*
          Letter-spaced in CSS rather than run together: these are four unrelated
          characters, read out one at a time and not pronounced as a word.
        */}
        <p className="code__value">{view.roomCode}</p>
        <p className="code__hint">Read it out to whoever is playing with you.</p>
      </header>

      {/*
        The roster and the room's settings scroll together, so that however many seats fill
        and however tall the settings are, the controls stay at the bottom of the phone
        where a thumb is.
      */}
      <div className="lobby__body">
        <ul className="seats">
          {seats.map((seat) => (
            <li className="seat" key={seat.id}>
              <span className="seat__name">{seat.name}</span>
              {/*
                "you" can only be decided here — it depends on whose screen this is, which
                is why it is never stored or sent over the wire.
              */}
              {seat.id === view.you.id && <span className="seat__mark">you</span>}
              {seat.id === view.hostId && <span className="seat__mark">host</span>}
            </li>
          ))}
        </ul>

        {/*
          The host's four choices, or the same four as text for everybody else. Shown on
          this screen and no other, because this is the only phase they can be edited in —
          once the match starts they move behind the icon every in-match screen carries.

          Which of the two a player gets is a courtesy and not the rule: the server answers
          a guest's `updateSettings` with `NOT_HOST` whatever this screen chose to draw.
        */}
        {isHost ? (
          <SettingsEditor
            settings={view.settings}
            humanCount={humanCount}
            busy={busy}
            onChange={onUpdateSettings}
          />
        ) : (
          <SettingsPanel>
            {/* Says whose they are, so a guest is not hunting for the controls. */}
            <p className="hint hint--inline">The host sets these.</p>
            <SettingsValues
              settings={view.settings}
              botCount={effectiveBotCount(view.settings, humanCount)}
            />
          </SettingsPanel>
        )}
      </div>

      <div className="lobby__actions">
        {isHost ? (
          <button
            className="button button--primary"
            type="button"
            onClick={onStart}
            disabled={busy}
          >
            Start the match
          </button>
        ) : (
          // Its own class rather than `notice`, which carries news that has just
          // arrived. This is a standing fact about the screen.
          <p className="hint">The host starts the match.</p>
        )}

        {/* Closing it for the host, leaving it for everybody else — see `WayOut.tsx`. */}
        <WayOut isHost={isHost} busy={busy} onExit={onExit} onCloseRoom={onCloseRoom} />
      </div>

      {error && (
        <p className="notice notice--error" role="alert">
          {error.message}
        </p>
      )}
    </main>
  );
}
