/**
 * A `RoomsPort` with no transport under it, for driving `Rooms` without a socket
 * (docs/adr/0025).
 *
 * It stands where the socket adapter stands and does the two things that adapter does:
 * answers who is connected to a room — here, whoever the test last said — and takes every
 * delivery it is handed. Nothing is sent anywhere; every delivery is kept, per room and in
 * order, so a test asserts on exactly what `Rooms` handed the transport.
 *
 * A test helper and not shipped: nothing in the server has a use for a transport that
 * reaches nobody.
 */

import type { PlayerGameView } from "@yaniv/shared";
import type { RoomsPort } from "../src/rooms.ts";

/** One publication: a view per seat, as `Rooms` handed it over. */
export type Delivery = ReadonlyMap<string, PlayerGameView>;

export interface RecordingPort extends RoomsPort {
  /**
   * Say who is connected to a room from now on — the fact only a transport knows. Setting
   * it tells `Rooms` nothing: a test calls `attendanceChanged` after it, as the adapter
   * does after binding a seat or losing one.
   */
  setConnected: (roomCode: string, playerIds: Iterable<string>) => void;
  /** Every delivery to a room so far, oldest first. */
  deliveries: (roomCode: string) => Delivery[];
  /**
   * Every view one seat would have received, oldest first: its entry in each delivery made
   * while it was connected. The adapter sends a view only to a connection bound to that
   * seat, so an entry for a seat nobody was holding reaches nobody.
   */
  received: (roomCode: string, playerId: string) => PlayerGameView[];
}

export function recordingPort(): RecordingPort {
  const connected = new Map<string, ReadonlySet<string>>();
  const delivered = new Map<string, { to: ReadonlySet<string>; views: Delivery }[]>();

  const connectedTo = (roomCode: string) => connected.get(roomCode) ?? new Set<string>();
  const deliveredTo = (roomCode: string) => delivered.get(roomCode) ?? [];

  return {
    connected: (roomCode) => new Set(connectedTo(roomCode)),
    deliver: (roomCode, views) => {
      // Copied on the way in, so a caller that went on to change its map could not
      // rewrite what this says it was handed.
      delivered.set(roomCode, [
        ...deliveredTo(roomCode),
        { to: connectedTo(roomCode), views: new Map(views) },
      ]);
    },
    setConnected: (roomCode, playerIds) => {
      connected.set(roomCode, new Set(playerIds));
    },
    deliveries: (roomCode) => deliveredTo(roomCode).map(({ views }) => views),
    received: (roomCode, playerId) =>
      deliveredTo(roomCode).flatMap(({ to, views }) => {
        const view = views.get(playerId);
        return view && to.has(playerId) ? [view] : [];
      }),
  };
}
