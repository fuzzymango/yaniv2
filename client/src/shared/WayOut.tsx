/**
 * How a player gets out of a room, which is now one thing and the same thing for
 * everybody: they **leave**. Their seat is freed and the room plays on for whoever
 * remains — in the lobby the host's role migrates along with it, and from the first deal
 * there is no host to migrate (docs/adr/0012).
 *
 * There used to be a second way out here: the host's close-room, which ended the match
 * for everyone else from any phase. It is gone, and with it the possibility of one player
 * ending four others' game. A room ends when its last seat leaves.
 *
 * Nothing is asked before it acts, unlike the control this replaces: a leave costs nobody
 * but the leaver, so there is no misplaced thumb here that takes somebody else's game with
 * it. Presentational, and offered to everyone — the server refuses a leave to nobody who
 * is in a room to leave it.
 */

interface WayOutProps {
  busy: boolean;
  onExit: () => void;
}

export function WayOut({ busy, onExit }: WayOutProps) {
  // Promises nothing about the rest of the table, because leaving costs it nothing: the
  // room plays on without whoever goes.
  return (
    <button className="button" type="button" onClick={onExit} disabled={busy}>
      Leave the room
    </button>
  );
}
