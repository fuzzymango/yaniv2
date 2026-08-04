/**
 * Which screen a player is looking at.
 *
 * There is no router and there are no URLs: the main menu is the screen with no view at
 * all — no room exists, so there is nothing for the server to have sent — and every
 * other screen is a function of the view it renders. See docs/adr/0004.
 */

import { Lobby } from "./Lobby.tsx";
import { MainMenu } from "./MainMenu.tsx";
import { Room } from "./Room.tsx";
import { Table } from "./Table.tsx";
import type { Session } from "./session.ts";
import { useSession } from "./useSession.ts";

export function App({ session }: { session: Session }) {
  const { view, error, notice, busy, selection } = useSession(session);

  if (view === null) {
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

  // Pulled out so the early return narrows it: everything past this point is a phase
  // with a round dealt behind it, and `Room` is typed to accept only those.
  const { phase } = view;

  if (phase === "lobby") {
    return (
      <Lobby
        view={view}
        error={error}
        busy={busy}
        onStart={session.startGame}
        onExit={session.exitToMenu}
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
      />
    );
  }

  return <Room view={view} phase={phase} />;
}
