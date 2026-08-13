import type {
  OpponentView,
  PlayerGameView,
  RoundResultView,
  SelfView,
} from "@yaniv/shared";
import { sortHand } from "@yaniv/shared";
import type { GameState, RoundResult } from "./state.ts";

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
      scoreAfter: p.scoreAfter,
    })),
  };
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
    roundResult:
      revealing && state.lastRoundResult
        ? toRoundResultView(state.lastRoundResult)
        : null,
    winnerIds: state.phase === "gameEnd" ? state.winnerIds : null,
  };
}
