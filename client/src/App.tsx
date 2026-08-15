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
 */

import { Disconnected } from "./Disconnected.tsx";
import { GameEnd } from "./GameEnd.tsx";
import { Lobby } from "./Lobby.tsx";
import { MainMenu } from "./MainMenu.tsx";
import { Resuming } from "./Resuming.tsx";
import { Room } from "./Room.tsx";
import { RoundEnd } from "./RoundEnd.tsx";
import { Table } from "./Table.tsx";
import type { Session } from "./session.ts";
import { useSession } from "./useSession.ts";

export function App({ session }: { session: Session }) {
  const { view, error, notice, busy, connected, resuming, selection } = useSession(session);

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

  if (phase === "playing") {
    return (
      <Table
        view={view}
        selection={selection}
        error={error}
        busy={busy}
        onToggleCard={session.toggleCard}
        onCommitTurn={session.commitTurn}
        onCallYaniv={session.callYaniv}
        onSlapDown={session.slapDown}
        onCloseRoom={session.closeRoom}
      />
    );
  }

  /*
   * The standings need no round behind them — they are a function of the roster and the
   * scores on it, and the round result only adds back whoever has left since. So this
   * screen is reached on the phase alone, unlike the one below.
   */
  if (phase === "gameEnd") {
    return (
      <GameEnd
        view={view}
        error={error}
        busy={busy}
        onPlayAgain={session.playAgain}
        onExit={session.exitToMenu}
        onCloseRoom={session.closeRoom}
      />
    );
  }

  /*
   * A scored round comes with the round it scored — the serializer populates `roundResult`
   * at `roundEnd` and `gameEnd` and nowhere else. The wire type still allows a null, so the
   * screen that needs one is reached only when there is one, and the stand-in below catches
   * a position that should not exist rather than a component asserting its way past it.
   */
  if (phase === "roundEnd" && view.roundResult !== null) {
    return (
      <RoundEnd
        view={view}
        result={view.roundResult}
        error={error}
        busy={busy}
        onNextRound={session.startNextRound}
        onCloseRoom={session.closeRoom}
      />
    );
  }

  return <Room view={view} phase={phase} />;
}
