import type {
  Card,
  DrawSource,
  LastMoveView,
  MatchStanding,
  MoveHistoryEntryView,
  OpponentView,
  PlayerGameView,
  RoundResultView,
  SeatView,
  SelfView,
} from "@yaniv/shared";
import { sortHand } from "@yaniv/shared";
import type {
  GameState,
  LastMove,
  MoveHistoryEntry,
  Player,
  RoundResult,
} from "./state.ts";
import { inMatch, spectating } from "./state.ts";

/**
 * No sockets to ask about: what a caller with no transport under it passes for
 * `connectedPlayerIds` (issue #146).
 *
 * There are two, and both are reading a view rather than sending one — a bot deciding its
 * turn (`botTurns.ts`) and the in-process demo harness (`scripts/play.ts`). Neither has a
 * connection to report and neither reads the field, so this says exactly that rather than
 * inventing a set. Anything that *publishes* a view knows who is there and says so.
 */
export const NO_CONNECTIONS: ReadonlySet<string> = new Set();

/**
 * Names come from the result itself, not from the roster: a scored round is a record of
 * who played it, and it says what to draw at a seat rather than which seat to draw it at.
 */
function toRoundResultView(result: RoundResult): RoundResultView {
  return {
    roundNumber: result.roundNumber,
    callerId: result.callerId,
    assaferId: result.assaferId,
    winnerId: result.winnerId,
    players: result.players.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      hand: sortHand(p.hand),
      handValue: p.handValue,
      delta: p.delta,
      milestoneReduction: p.milestoneReduction,
      scoreAfter: p.scoreAfter,
    })),
  };
}

/**
 * Where a seat stands in the match, for either view. Nothing is redacted: whether a player
 * is still in it is a public fact about a table — every other seat watched them go out —
 * and both views carry it so a client can draw every seat in its correct state.
 *
 * One helper for the two views and both phases, so a seat cannot read as out to one
 * viewer and in to another. Connection is public on the same grounds and arrives the same
 * way: as an answer already worked out for this publication (`connectedTo` below).
 */
function standingOf(player: Player, connected: boolean): MatchStanding {
  return { outInRound: player.outInRound, departed: player.departed, connected };
}

/**
 * Whether somebody is there behind one seat, at the moment this payload is being built
 * (issue #146, docs/adr/0013).
 *
 * The live socket set is the whole of it, plus two seats that are never away for reasons
 * that have nothing to do with sockets. **The viewer**, because this payload exists on
 * account of the connection it is about to go down — asking the set about them would let a
 * caller hand a client a view of itself as gone. **A bot**, because there is no connection
 * for one to lose: the server plays it, and the absence of any marker at its seat is what
 * says it is a bot rather than somebody who has stepped away.
 */
function connectedTo(
  player: Player,
  viewerPlayerId: string,
  live: ReadonlySet<string>,
): boolean {
  return player.id === viewerPlayerId || player.isBot || live.has(player.id);
}

/**
 * The viewer's own view, in whichever of its two shapes they are entitled to (issue #143).
 *
 * The tag is `spectating` from `state.ts` and nothing else, so which shape a seat gets is
 * one derivation rather than one per phase — and a spectator's shape carries no hand and
 * no eligibility field to fill in, which is what makes "a spectator holding cards" not a
 * mistake this function could make.
 *
 * **It widens nothing.** Everything below this line is about the viewer's own seat: a
 * spectator's payload is an active player's minus a hand, never plus anything, because
 * being knocked out must not turn a player into an oracle for a friend still playing.
 * One function for both phases, so the lobby and a dealt round cannot answer differently.
 */
function selfViewOf(
  viewer: Player,
  hand: Card[],
  slapdownEligible: boolean,
): SelfView {
  const seat: SeatView = {
    id: viewer.id,
    name: viewer.name,
    score: viewer.score,
    // Connected, and not asked: see `connectedTo`. A viewer is by definition somebody
    // there to be sent this, which is also what makes their own shape decidable here.
    ...standingOf(viewer, true),
  };
  return spectating(viewer, true)
    ? { ...seat, spectating: true }
    : { ...seat, spectating: false, hand, slapdownEligible };
}

/**
 * One other seat, in whichever phase — everything public about a player who is not the
 * viewer, and nothing else: there is no `hand` field here to leave empty.
 *
 * Presence is passed in rather than asked for twice: whether somebody is behind this seat
 * is one fact, and it decides both what the standing says and whether the seat is watching
 * the match. `spectating` is worked out here for every seat by the same predicate that
 * decides the viewer's own shape — which seats are bots is not on the wire, so a client
 * could not tell a watcher from one.
 */
function opponentViewOf(
  player: Player,
  connected: boolean,
  handSize: number,
): OpponentView {
  return {
    id: player.id,
    name: player.name,
    score: player.score,
    ...standingOf(player, connected),
    spectating: spectating(player, connected),
    handSize,
  };
}

/**
 * Where everybody sits: the roster in its own order, unfiltered (issue #144).
 *
 * The whole of it, out and departed seats included, and the same list for every viewer —
 * a table that is being drawn round the felt has a place for each of them, and dropping a
 * seat here is what would slide everybody else along it. `inMatch` is turn order's filter
 * and not this one; the two lists were equal until elimination made them different
 * questions ("Turn order vs. seating" in CONTEXT.md).
 */
function seatingOf(state: GameState): string[] {
  return state.players.map((p) => p.id);
}

/**
 * What one viewer may be told about a drawn card: the card itself, or nothing.
 *
 * Whose turn it was and where they drew from are public — a table can watch both happen.
 * Which card it was is not, when it came off the deck: that card is now part of a hidden
 * hand, and naming it would leak through the back door what `OpponentView` is shaped to
 * keep out. A card taken off the pile was face up a moment earlier, so there is nothing
 * left to hide about it.
 *
 * One function rather than the same condition written out at each of its two call sites:
 * the last move and the round's log are the same fact a moment apart, so a rule that could
 * drift between them is a rule the older of the two would quietly relax.
 */
function drawnCardFor(
  move: { playerId: string; drawSource: DrawSource; drawnCard: Card },
  viewerPlayerId: string,
): Card | null {
  const revealed =
    move.drawSource === "discard" || move.playerId === viewerPlayerId;
  return revealed ? move.drawnCard : null;
}

/** The move that just resolved, redacted for one viewer. */
function toLastMoveView(move: LastMove, viewerPlayerId: string): LastMoveView {
  return {
    playerId: move.playerId,
    drawSource: move.drawSource,
    drawnCard: drawnCardFor(move, viewerPlayerId),
  };
}

/**
 * The round's log, redacted for one viewer entry by entry, on the same rule and not a
 * looser one: a card that was the mover's alone when it was drawn does not become anybody
 * else's for having scrolled up the list. A slapdown passes through whole, its card having
 * been face up on the pile since it landed.
 *
 * The whole list goes to every viewer in every phase — what varies is only which drawn
 * cards are named, which is why there is nothing here about `roundEnd`.
 */
function toMoveHistoryView(
  history: MoveHistoryEntry[],
  viewerPlayerId: string,
): MoveHistoryEntryView[] {
  return history.map((entry) =>
    entry.kind === "slapdown"
      ? entry
      : {
          kind: "turn",
          playerId: entry.playerId,
          discarded: entry.discarded,
          drawSource: entry.drawSource,
          drawnCard: drawnCardFor(entry, viewerPlayerId),
        },
  );
}

/**
 * Reduce the server's full `GameState` to what one player is allowed to see.
 *
 * This is the security boundary: `GameState` holds every hand and the exact draw pile
 * order, so it must never reach a client. Broadcast by calling this once per socket,
 * never `io.to(room).emit(...)` with raw state.
 *
 * Hands other than the viewer's are exposed only in `roundEnd` / `gameEnd`, where the
 * rules require every hand to be revealed so the Yaniv call can be verified.
 *
 * Throws if `viewerPlayerId` is not in the game — callers are expected to have
 * established membership already, so that is a defect rather than a rule violation.
 *
 * `connectedPlayerIds` is who has a live socket in the room right now, handed in rather
 * than read off the state: connection is a fact about the transport, and `GameState` has
 * none (issue #146, docs/adr/0013). Required rather than defaulted, so a call site that
 * knows cannot forget to say — the two that genuinely do not know pass `NO_CONNECTIONS`.
 */
export function serializeStateForPlayer(
  state: GameState,
  viewerPlayerId: string,
  connectedPlayerIds: ReadonlySet<string>,
): PlayerGameView {
  const viewer = state.players.find((p) => p.id === viewerPlayerId);
  if (!viewer) {
    throw new Error(
      `Cannot serialize state for unknown player ${viewerPlayerId} in room ${state.roomCode}`,
    );
  }

  /** One seat's presence, over the set and the two seats that never consult it. */
  const connected = (player: Player): boolean =>
    connectedTo(player, viewerPlayerId, connectedPlayerIds);

  if (state.phase === "lobby") {
    // Nobody is out of a match that has not been dealt, so this is always the playing
    // shape — arrived at by the same derivation as every other phase, rather than by
    // this branch knowing it.
    const you: SelfView = selfViewOf(viewer, [], false);
    const opponents: OpponentView[] = state.players
      .filter((p) => p.id !== viewerPlayerId)
      .map((p) => opponentViewOf(p, connected(p), 0));

    return {
      roomCode: state.roomCode,
      phase: state.phase,
      roundNumber: state.roundNumber,
      hostId: state.hostId,
      settings: state.settings,
      you,
      opponents,
      seating: seatingOf(state),
      // Every seat, a lobby being a table nobody has gone out of yet — but read off the
      // same rule the dealt rounds' turn order is built by, rather than off the roster.
      turnOrder: state.players.filter(inMatch).map((p) => p.id),
      currentTurnPlayerId: null,
      drawPileCount: 0,
      lastDiscard: [],
      buriedCount: 0,
      lastMove: null,
      lastSlapdown: null,
      moveHistory: [],
      roundResult: null,
      // Empty, and sent anyway: the scorecard rides every phase (docs/adr/0017), so a
      // client reads one field in all four rather than a field that is sometimes absent.
      scorecard: state.scorecard,
      winnerIds: null,
    };
  }

  const round = state.round;

  const you: SelfView = selfViewOf(
    viewer,
    // Sorted here rather than in the engine: hand order is presentation, and this
    // is the one place every client is guaranteed to go through.
    sortHand(round.hands[viewer.id] ?? []),
    // Told only to whoever holds the window: an open window is a fact about the holder's
    // hand, so it goes no further. Gated on the phase the same way `currentTurnPlayerId`
    // below is — both are answers about a round still being played.
    state.phase === "playing" && round.slapdown?.playerId === viewer.id,
  );

  const opponents: OpponentView[] = state.players
    .filter((p) => p.id !== viewerPlayerId)
    // Zero cards for a seat that is out: it holds no hand, the round having been dealt
    // without it — the same absence a client draws an empty seat from.
    .map((p) => opponentViewOf(p, connected(p), round.hands[p.id]?.length ?? 0));

  const revealing = state.phase === "roundEnd" || state.phase === "gameEnd";

  return {
    roomCode: state.roomCode,
    phase: state.phase,
    roundNumber: state.roundNumber,
    // The role retired with the first deal, and this is where that is said: a round has
    // been dealt, so there is no host to name. docs/adr/0012.
    hostId: null,
    settings: state.settings,
    you,
    opponents,
    seating: seatingOf(state),
    turnOrder: round.turnOrder,
    currentTurnPlayerId: state.phase === "playing" ? round.currentTurnPlayerId : null,
    drawPileCount: round.drawPile.length,
    lastDiscard: round.lastDiscard,
    buriedCount: round.buried.length,
    lastMove: round.lastMove ? toLastMoveView(round.lastMove, viewer.id) : null,
    // Passed through whole, unlike the move above: the card it names is on the face-up
    // pile every viewer is sent in full, so there is nothing here for one player to know
    // and another not — and so no per-viewer view of it to build. docs/adr/0008.
    lastSlapdown: round.lastSlapdown,
    moveHistory: toMoveHistoryView(round.moveHistory, viewer.id),
    roundResult:
      revealing && state.lastRoundResult
        ? toRoundResultView(state.lastRoundResult)
        : null,
    // Passed through whole, in every phase and to every viewer: the same type on the wire
    // as in the model, there being nothing here one player may know and another may not
    // (docs/adr/0017). At `roundEnd` its newest row is the round `roundResult` above is
    // revealing — the same round answering two different questions.
    scorecard: state.scorecard,
    winnerIds: state.phase === "gameEnd" ? state.winnerIds : null,
  };
}
