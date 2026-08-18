import type {
  LastMoveView,
  MoveHistoryEntryView,
  OpponentView,
  PlayerGameView,
  RoundResultView,
  SelfView,
} from "@yaniv/shared";
import { sortHand } from "@yaniv/shared";
import type {
  GameState,
  LastMove,
  MoveHistoryEntry,
  RoundResult,
} from "./state.ts";

/**
 * Names come from the result itself, not from the roster: a player may have given their
 * seat up since the match ended, and the round they played is still theirs.
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
 * Redact the move that just resolved for one viewer.
 *
 * Whose turn it was and where they drew from are public — a table can watch both happen.
 * Which card it was is not, when it came off the deck: that card is now part of a hidden
 * hand, and naming it here would leak through the back door what `OpponentView` is shaped
 * to keep out. A card taken off the pile was face up a moment earlier, so there is
 * nothing left to hide about it.
 */
function toLastMoveView(move: LastMove, viewerPlayerId: string): LastMoveView {
  const revealed =
    move.drawSource === "discard" || move.playerId === viewerPlayerId;
  return {
    playerId: move.playerId,
    drawSource: move.drawSource,
    drawnCard: revealed ? move.drawnCard : null,
  };
}

/**
 * Redact the round's log for one viewer, entry by entry.
 *
 * Deliberately the same rule as `toLastMoveView` above and not a looser one: a logged turn
 * is the same fact a moment later, and a card that was the mover's alone when it was drawn
 * does not become anybody else's for having scrolled up the list. A slapdown passes through
 * whole, its card having been face up on the pile since it landed.
 *
 * The whole list goes to every viewer in every phase — what varies is only which drawn
 * cards are named, which is why there is nothing here about `roundEnd`.
 */
function toMoveHistoryView(
  history: MoveHistoryEntry[],
  viewerPlayerId: string,
): MoveHistoryEntryView[] {
  return history.map((entry) => {
    if (entry.kind === "slapdown") return entry;
    const revealed =
      entry.drawSource === "discard" || entry.playerId === viewerPlayerId;
    return {
      kind: "turn",
      playerId: entry.playerId,
      discarded: entry.discarded,
      drawSource: entry.drawSource,
      drawnCard: revealed ? entry.drawnCard : null,
    };
  });
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
 */
export function serializeStateForPlayer(
  state: GameState,
  viewerPlayerId: string,
): PlayerGameView {
  const viewer = state.players.find((p) => p.id === viewerPlayerId);
  if (!viewer) {
    throw new Error(
      `Cannot serialize state for unknown player ${viewerPlayerId} in room ${state.roomCode}`,
    );
  }

  if (state.phase === "lobby") {
    const you: SelfView = {
      id: viewer.id,
      name: viewer.name,
      score: viewer.score,
      hand: [],
      slapdownEligible: false,
    };
    const opponents: OpponentView[] = state.players
      .filter((p) => p.id !== viewerPlayerId)
      .map((p) => ({ id: p.id, name: p.name, score: p.score, handSize: 0 }));

    return {
      roomCode: state.roomCode,
      phase: state.phase,
      roundNumber: state.roundNumber,
      hostId: state.hostId,
      settings: state.settings,
      you,
      opponents,
      turnOrder: state.players.map((p) => p.id),
      currentTurnPlayerId: null,
      drawPileCount: 0,
      lastDiscard: [],
      buriedCount: 0,
      lastMove: null,
      lastSlapdown: null,
      moveHistory: [],
      roundResult: null,
      winnerIds: null,
    };
  }

  const round = state.round;

  const you: SelfView = {
    id: viewer.id,
    name: viewer.name,
    score: viewer.score,
    // Sorted here rather than in the engine: hand order is presentation, and this
    // is the one place every client is guaranteed to go through.
    hand: sortHand(round.hands[viewer.id] ?? []),
    // Told only to whoever holds the window: an open window is a fact about the holder's
    // hand, so it goes no further. Gated on the phase the same way `currentTurnPlayerId`
    // below is — both are answers about a round still being played.
    slapdownEligible:
      state.phase === "playing" && round.slapdown?.playerId === viewer.id,
  };

  const opponents: OpponentView[] = state.players
    .filter((p) => p.id !== viewerPlayerId)
    .map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      handSize: round.hands[p.id]?.length ?? 0,
    }));

  const revealing = state.phase === "roundEnd" || state.phase === "gameEnd";

  return {
    roomCode: state.roomCode,
    phase: state.phase,
    roundNumber: state.roundNumber,
    hostId: state.hostId,
    settings: state.settings,
    you,
    opponents,
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
    winnerIds: state.phase === "gameEnd" ? state.winnerIds : null,
  };
}
