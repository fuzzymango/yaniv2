/**
 * The room before the cards come out: its code, who is in it, and the two things left to
 * do — start, or leave.
 *
 * The first screen that is a function of `view.phase`. There is no route behind it and no
 * URL to reach it by; a player is looking at the lobby because the server says the room is
 * in it. See docs/adr/0004.
 *
 * Nothing here decides anything. The host marker, the start control and the ✕ on a row are
 * display: who may actually start or remove is the server's call, and it answers anyone else
 * with `NOT_HOST`. Showing the controls to the host alone spares a guest hunting for a button
 * that was never theirs — it is not what enforces the rule.
 *
 * The one screen in this client with a host on it at all. The role is the lobby's — the
 * settings, the start and freeing a seat (docs/adr/0028) — and it retires at the first deal,
 * `view.hostId` going null with it (docs/adr/0012). A host who leaves hands it to the next
 * seat, which arrives here as an ordinary roster update with the marker on somebody else.
 */

import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { PlayerGameView, RoomSettings } from "@yaniv/shared";
import { effectiveBotCount } from "@yaniv/shared";
import { SettingsEditor } from "./SettingsEditor.tsx";
import { SettingsPanel } from "../settings/SettingsPanel.tsx";
import { SettingsValues } from "../settings/SettingsValues.tsx";
import { WayOut } from "../shared/WayOut.tsx";
import { bySeat } from "../seating.ts";
import { STATUS_LABEL, seatStatus } from "../status.ts";

/**
 * How long a ✕ ignores taps, counted from the last tap and from the last time the rows moved
 * (docs/adr/0028). `busy` lets go on the ack and the rows below close up, so a tap meant for one
 * player would land on the next player's ✕. A tap that is ignored still counts, or a third tap
 * of a burst would get through. It outlasts a double tap's gap and is short enough for a
 * deliberate second kick.
 */
const KICK_HOLD_MS = 400;

interface LobbyProps {
  view: PlayerGameView;
  busy: boolean;
  onStart: () => void;
  onUpdateSettings: (settings: RoomSettings) => void;
  onKick: (playerId: string) => void;
  onExit: () => void;
}

export function Lobby({
  view,
  busy,
  onStart,
  onUpdateSettings,
  onKick,
  onExit,
}: LobbyProps) {
  const isHost = view.hostId === view.you.id;

  const seats = [view.you, ...view.opponents].sort(bySeat(view));

  const heldUntil = useRef(0);
  const hold = () => {
    heldUntil.current = performance.now() + KICK_HOLD_MS;
  };
  useEffect(hold, [seats.length]);
  const kick = (playerId: string) => {
    const held = performance.now() < heldUntil.current;
    hold();
    if (!held) onKick(playerId);
  };

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
      </header>

      {/*
        The roster and the room's settings scroll together, so that however many seats fill
        and however tall the settings are, the controls stay at the bottom of the phone
        where a thumb is. The roster goes two across before it comes to that (issue #263).
      */}
      <div className="lobby__body">
        {/*
          The rows the roster asks for — one per seat — and its floor, half of them, which
          caps it at two across. Arithmetic on the count, not a measurement: CSS decides
          whether one column fits.
        */}
        <ul
          className="seats"
          style={
            {
              "--seats": seats.length,
              "--seat-rows": Math.ceil(seats.length / 2),
            } as CSSProperties
          }
        >
          {seats.map((seat) => {
            const status = seatStatus(seat);
            return (
              <li className="seat" key={seat.id}>
                {/*
                  The name and its chips, apart from the ✕: where a two-across row is too
                  narrow for both on one line, the chips move under the name as one group.
                */}
                <span className="seat__who">
                  <span className="seat__name">{seat.name}</span>
                  <span className="seat__chips">
                    {/*
                      "you" can only be decided here — it depends on whose screen this is,
                      which is why it is never stored or sent over the wire.
                    */}
                    {seat.id === view.you.id && <span className="seat__mark">you</span>}
                    {seat.id === view.hostId && <span className="seat__mark">host</span>}
                    {/*
                      The same status slot the felt's seats carry (issue #146), off the same
                      rule. In a lobby only one of its three words can ever come up — nobody
                      is out of a match that has not been dealt, and a player who leaves one
                      is spliced out of the roster — so this row says "away" or nothing.
                      Worth saying here for the reason it is worth saying at the table: a
                      room waiting to start should not be waiting on somebody whose phone
                      locked itself.
                    */}
                    {status && (
                      <span className={`seat__status seat__status--${status}`}>
                        {STATUS_LABEL[status]}
                      </span>
                    )}
                  </span>
                </span>
                {/*
                  One tap and no confirm (docs/adr/0028): a seat removed by mistake costs that
                  player the code again, and an "away" row gets one too, being the seat most
                  worth freeing. Never the host's own row — leaving is the way out below.
                */}
                {isHost && seat.id !== view.you.id && (
                  <button
                    className="seat__remove"
                    type="button"
                    aria-label={`Remove ${seat.name}`}
                    onClick={() => kick(seat.id)}
                    disabled={busy}
                  >
                    ✕
                  </button>
                )}
              </li>
            );
          })}
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
        {/*
          Nothing in Start's place for a guest: the roster's HOST mark and "The host sets
          these" already say whose the room is, and Leave takes the whole row.
        */}
        {isHost && (
          <button
            className="button button--primary"
            type="button"
            onClick={onStart}
            disabled={busy}
          >
            Start
          </button>
        )}

        {/*
          The same way out for everybody, the host included: leaving a lobby hands the role
          to the next seat rather than ending the room (docs/adr/0012).
        */}
        <WayOut busy={busy} onExit={onExit} />
      </div>
    </main>
  );
}
