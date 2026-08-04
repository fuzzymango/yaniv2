/**
 * The whole of React's knowledge of the session: subscribe, and read the snapshot.
 *
 * Deliberately logic-free. Anything that looks like it belongs here — validating a
 * name, normalising a code, deciding when controls lock — belongs in the session core,
 * where it can be tested under `node:test` without a browser. If this file ever grows a
 * branch, that branch is in the wrong place.
 */

import { useSyncExternalStore } from "react";
import type { Session, SessionSnapshot } from "./session.ts";

export function useSession(session: Session): SessionSnapshot {
  return useSyncExternalStore(session.subscribe, session.getSnapshot);
}
