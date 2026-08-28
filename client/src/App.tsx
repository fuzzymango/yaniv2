/**
 * Which screen a player is looking at.
 *
 * There is no router and there are no URLs: the main menu is the screen with no view at
 * all — no room exists, so there is nothing for the server to have sent — and every
 * other screen is a function of the view it renders. See docs/adr/0004.
 *
 * Three screens are not a function of the view, and all three are asked about before the
 * phase is: a lost connection, which makes every control on every other screen a lie; a
 * seat being claimed back, which is what an empty screen means before it means the menu;
 * and then the main menu itself.
 *
 * One branch renders two screens rather than one: a finished match is `Table` with `GameEnd`
 * drawn over it (issue #130). Everywhere else a phase picks exactly one component.
 */

import { Disconnected } from "./connection/Disconnected.tsx";
import { Resuming } from "./connection/Resuming.tsx";
import { GameEnd } from "./game-end/GameEnd.tsx";
import { Lobby } from "./lobby/Lobby.tsx";
import { MainMenu } from "./main-menu/MainMenu.tsx";
import { Room } from "./table/Room.tsx";
import { Table } from "./table/Table.tsx";
import type { Session } from "./session.ts";
import { useSession } from "./useSession.ts";

export function App({ session }: { session: Session }) {
  const { view, error, notice, busy, connected, resuming, selection, flight } =
    useSession(session);

  /*
   * Before anything else, and whatever position was last drawn: with no socket there is
   * nothing behind any of it, and every control on the table would still look live. What
   * the last position was does not matter, because there is no going back to it — see
   * `Disconnected.tsx`.
   */
  if (!connected) return <Disconnected />;

  if (view === null) {
    /*
     * A page that opened on a stored seat has no position yet and is not at the main menu
     * either — it is waiting on the answer to a claim it has already sent. So the claim is
     * asked about here, inside the branch it would otherwise be mistaken for, and nowhere
     * else: a connection that comes back mid-match claims its seat with the last position
     * still on the screen, and putting a spinner over that would throw away the very thing
     * being asked for.
     */
    if (resuming) return <Resuming />;

    return (
      <MainMenu
        error={error}
        notice={notice}
        busy={busy}
        onCreate={session.createRoom}
        onJoin={session.joinRoom}
      />
    );
  }

  // Pulled out so the early returns narrow it: what reaches the bottom of this function is
  // whatever has no screen of its own, and `Room` is typed to accept only that. Adding a
  // phase is then a typecheck here rather than a blank screen in a browser.
  const { phase } = view;

  if (phase === "lobby") {
    return (
      <Lobby
        view={view}
        error={error}
        busy={busy}
        onStart={session.startGame}
        onUpdateSettings={session.updateSettings}
        onExit={session.exitToMenu}
        onCloseRoom={session.closeRoom}
      />
    );
  }

  /*
   * One screen for the hand being played, the hand just scored (issue #78) and the match
   * they ended (issue #130): a round ending is the next moment of the same table and a match
   * ending is the moment after that, not a different page either time. So the branch here is
   * one, and `Table` changes what its slots say — and which of them it offers at all — rather
   * than the phase changing screens under the player.
   *
   * A scored round comes with the round it scored — the serializer populates `roundResult`
   * at `roundEnd` and `gameEnd` and nowhere else. The wire type still allows a null, so a
   * `roundEnd` without one falls through to the stand-in below rather than to a table with
   * nothing to reveal. `gameEnd` is reached on the phase alone all the same: the standings
   * are a function of the roster and the scores on it, so the panel still says who won over
   * a table with nothing revealed under it.
   *
   * One `Table` for the three, and not one per branch: it is the same table, and a second
   * call site is a second list of props to keep in step with it.
   */
  if (
    phase === "playing" ||
    phase === "gameEnd" ||
    (phase === "roundEnd" && view.roundResult !== null)
  ) {
    const table = (
      <Table
        view={view}
        selection={selection}
        /*
         * A finished match reports through the panel over the table, which is what every
         * action left on this screen is asked through: one message, in the one place a
         * player is looking.
         */
        error={phase === "gameEnd" ? null : error}
        busy={busy}
        flight={flight}
        onToggleCard={session.toggleCard}
        onCommitTurn={session.commitTurn}
        onCallYaniv={session.callYaniv}
        onNextRound={session.startNextRound}
        onSlapDown={session.slapDown}
        onExit={session.exitToMenu}
        onCloseRoom={session.closeRoom}
      />
    );

    if (phase !== "gameEnd") return table;

    /*
     * The finished match: the table it finished on, with the standings floating over it.
     * The two are siblings — `GameEnd` is fixed to the viewport and drawn over `Table`, the
     * same shape `Table` already uses for the flight layer — rather than one being composed
     * inside the other, which would make the panel part of a column it is floating above.
     */
    return (
      <>
        {table}
        <GameEnd
          view={view}
          error={error}
          busy={busy}
          onPlayAgain={session.playAgain}
          onExit={session.exitToMenu}
          onCloseRoom={session.closeRoom}
        />
      </>
    );
  }

  return <Room view={view} phase={phase} />;
}
