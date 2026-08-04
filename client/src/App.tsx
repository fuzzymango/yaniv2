/**
 * Which screen a player is looking at.
 *
 * There is no router and there are no URLs: the main menu is the screen with no view at
 * all — no room exists, so there is nothing for the server to have sent — and every
 * other screen is a function of the view it renders. See docs/adr/0004.
 */

import { MainMenu } from "./MainMenu.tsx";
import { Room } from "./Room.tsx";
import type { Session } from "./session.ts";
import { useSession } from "./useSession.ts";

export function App({ session }: { session: Session }) {
  const { view, error, busy } = useSession(session);

  if (view === null) {
    return (
      <MainMenu
        error={error}
        busy={busy}
        onCreate={session.createRoom}
        onJoin={session.joinRoom}
      />
    );
  }

  return <Room view={view} />;
}
