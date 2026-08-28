import type { Card, TurnAction } from "@yaniv/shared";
import {
  ASSAF_PENALTY,
  MILESTONE_INTERVAL,
  MILESTONE_REDUCTION,
  MIN_PLAYERS,
  canCallYaniv,
  canonicalizeSet,
  handValue,
  isValidSet,
  isValidSettings,
  opensSlapdown,
  pickupCandidates,
} from "@yaniv/shared";
import { createDeck, deal, shuffle } from "./deck.ts";
import { err, ok } from "./result.ts";
import { randomInt, type Rng } from "./rng.ts";
import type {
  ActionResult,
  GameState,
  GameStateActive,
  PlayerRoundResult,
  RoundResult,
  RoundState,
} from "./state.ts";
import { getPlayer, inMatch, playersInMatch, updatePlayer } from "./state.ts";

// ---------------------------------------------------------------------------
// Starting rounds
// ---------------------------------------------------------------------------

/**
 * Build a completely fresh round. Every round-scoped field is set here and nowhere
 * else, so there is no way for a value to survive from the previous round.
 */
function dealRound(
  state: GameState,
  startingPlayerId: string,
  rng: Rng,
): GameStateActive {
  // The players still in the match, and only those: a seat that has gone out is dealt no
  // hand and holds no place in turn order, while keeping its place in the roster — which
  // is what a table is drawn from. docs/rules.md §7.
  const turnOrder = playersInMatch(state).map((p) => p.id);
  const dealt = deal(
    shuffle(createDeck(), rng),
    turnOrder.length,
    state.settings.handSize,
  );

  const hands: Record<string, Card[]> = {};
  turnOrder.forEach((playerId, index) => {
    hands[playerId] = dealt.hands[index]!;
  });

  const round: RoundState = {
    hands,
    drawPile: dealt.drawPile,
    lastDiscard: [dealt.firstDiscard],
    buried: [],
    currentTurnPlayerId: startingPlayerId,
    turnOrder,
    slapdown: null,
    lastMove: null,
    lastSlapdown: null,
    moveHistory: [],
  };

  return {
    ...state,
    phase: "playing",
    roundNumber: state.roundNumber + 1,
    round,
    lastRoundResult: null,
    winnerIds: null,
  };
}

/**
 * Who opens a brand new match: a seat drawn uniformly at random, never the host by
 * default — see ADR-0001. Rounds after the first are not chosen this way; the previous
 * round's winner opens those.
 */
function randomOpener(state: GameState, rng: Rng): string {
  const seated = playersInMatch(state);
  return seated[randomInt(rng, seated.length)]!.id;
}

/**
 * The host starts the match from the lobby, but does not necessarily take the first
 * turn: the opening player is chosen uniformly at random from the seated players —
 * see ADR-0001.
 */
export function startGame(
  state: GameState,
  requesterId: string,
  rng: Rng,
): ActionResult {
  if (state.phase !== "lobby") {
    return err("WRONG_PHASE", "The game has already started");
  }
  if (requesterId !== state.hostId) {
    return err("NOT_HOST", "Only the host can start the game");
  }
  // Meaningful again now `botCount` defaults to zero (docs/adr/0006): this used to run
  // against a table `seatBots` had already filled to six, so it could never fire. A
  // lone host who has asked for no bots is now correctly turned away, while one who has
  // asked for some is counted with them and plays. Counted over the seats that would
  // actually be dealt to — in a lobby that is all of them, but the question is about the
  // match rather than the roster, and from the first deal the two differ.
  if (playersInMatch(state).length < MIN_PLAYERS) {
    return err(
      "NOT_ENOUGH_PLAYERS",
      `Need at least ${MIN_PLAYERS} players to start`,
    );
  }
  return ok(dealRound(state, randomOpener(state, rng), rng));
}

/**
 * Replace the room's settings, all four fields at once. docs/adr/0006.
 *
 * Only from the lobby, and only by the host: `startGame` deals against these values and
 * every client's own legality check reads them, so a change once a round exists would be
 * a rule changed out from under a match already being played. There is no way back to the
 * lobby afterwards — `playAgain` deals directly from `gameEnd` — which is what makes the
 * first deal a lock for the life of the room rather than for one match.
 *
 * `settings` is `unknown` on purpose. It arrives off the wire, where the type is a claim
 * by whoever sent it rather than a fact, and `isValidSettings` is the only thing that
 * turns it into a `RoomSettings` — so an out-of-range field cannot reach the room by
 * being asserted into the right shape. All four land or none do: this rejects before it
 * builds a state, so there is no partial update to undo.
 *
 * The four fields are copied out rather than the object stored as it arrived. A payload
 * can be a valid `RoomSettings` and still carry more, and `settings` is published whole
 * to every player (`serializeStateForPlayer`) — so anything riding along would be kept by
 * the room and handed back out to the table.
 */
export function updateSettings(
  state: GameState,
  requesterId: string,
  settings: unknown,
): ActionResult {
  if (state.phase !== "lobby") {
    return err("WRONG_PHASE", "Settings are locked once the match has started");
  }
  if (requesterId !== state.hostId) {
    return err("NOT_HOST", "Only the host can change the room's settings");
  }
  if (!isValidSettings(settings)) {
    return err("INVALID_SETTINGS", "Those settings are not ones a room can be played on");
  }

  const { handSize, yanivThreshold, maxScore, botCount } = settings;
  return ok({ ...state, settings: { handSize, yanivThreshold, maxScore, botCount } });
}

/**
 * Restart the match in the same room, for whoever is still seated: scores and the round
 * number go back to zero and the first round is dealt on the spot, so there is no stop
 * in the lobby between one match and the next.
 *
 * Every elimination is cleared with the scores (docs/rules.md §7): whoever is still in the
 * room is in the new match, however the last one ended for them. A seat that has been
 * *given up* is the exception and stays out — it is still in the roster, the roster being
 * append-only from the first deal, but it is nobody's seat to play.
 *
 * Empty seats are deliberately not backfilled with bots — a seat given up by an exit to
 * the menu stays given up — so a table that has shrunk below the minimum is turned away
 * here exactly as `startGame` would turn it away.
 */
export function playAgain(
  state: GameState,
  requesterId: string,
  rng: Rng,
): ActionResult {
  if (state.phase !== "gameEnd") {
    return err("WRONG_PHASE", "No finished match to replay");
  }
  /*
   * Anyone still in the room, which is deliberately a wider door than the next round's
   * (docs/adr/0012). At `gameEnd` exactly one player is still in the match and that
   * player may be a bot, so asking to be in the match would freeze a bot-won room with
   * nobody able to act; and a player knocked out of the last match is precisely who this
   * is offered to. A seat that has been given up is nobody's to ask from.
   */
  const requester = getPlayer(state, requesterId);
  if (!requester || requester.departed) {
    return err("PLAYER_NOT_FOUND", "You are not in this room");
  }
  // Counted over the seats that are still somebody's, not `inMatch`: everyone who is
  // still in the room plays the next match, and being knocked out of the last one is
  // exactly what this is offered to.
  if (state.players.filter((p) => !p.departed).length < MIN_PLAYERS) {
    // Said in terms of the table that is left rather than the lobby's "to start": whoever
    // reads this is looking at the standings of a match that has already been played, and
    // the seats it was played with are the thing that has since gone.
    return err(
      "NOT_ENOUGH_PLAYERS",
      `Too many players have left — another match needs at least ${MIN_PLAYERS}`,
    );
  }

  // Reset before dealing, so the fresh round is dealt against the fresh match: the
  // round number `dealRound` increments has to be the new match's, not the old one's.
  const fresh: GameState = {
    ...state,
    players: state.players.map((p) =>
      // A departed seat is out of the new match before it starts, which is round 0 — the
      // round count having gone back to zero with the scores, the old match's number
      // would name a round of a match this seat is no longer part of.
      p.departed
        ? { ...p, score: 0, outInRound: 0 }
        : { ...p, score: 0, outInRound: null },
    ),
    roundNumber: 0,
  };
  return ok(dealRound(fresh, randomOpener(fresh, rng), rng));
}

/**
 * Take a player out of the room, freeing their seat for good — no bot moves into it.
 *
 * Two shapes, on which side of the first deal the room is:
 *
 * - **In the lobby** the player is spliced out of the roster outright. A ghost seat in a
 *   room that has not dealt is noise, and there is no match record for it to be part of.
 * - **Once a match exists** the roster is append-only, and leaving *marks* the seat:
 *   `departed`, and out of the match as of the current round if it was not out already.
 *   That is what makes "out of the match, and gone" representable at all — a spliced-out
 *   seat cannot be drawn darkened at the table it played, or listed in its standings.
 *
 * **From any phase** (issue #147): nobody is trapped at a table that has gone quiet, and a
 * player the match has gone on without should not have to sit out somebody else's round to
 * get up. Mid-round the leaver is taken out of the round on the spot (`withdrawFromRound`
 * below) rather than the round being abandoned around them, and a departure that leaves
 * one player in the match ends it there and then.
 *
 * The host leaves like anybody else — what is special is the room left behind. In the
 * lobby the role migrates to the next remaining seat, so a room full of people is not
 * stranded because whoever clicked create wandered off; this is the one transition that
 * writes `hostId`, and it writes it only here (docs/adr/0012). Once a round has been
 * dealt there is no role to migrate: nobody is host from `playing` onward.
 *
 * A lobby whose last seat leaves keeps the `hostId` it had, there being nobody to hand it
 * to. "The room must be destroyed" is not a `GameState` this function could return, so
 * that branch belongs to the layer that owns rooms — the same way bot seating is a helper
 * folded in around a transition rather than baked into one.
 */
export function removePlayer(state: GameState, playerId: string): ActionResult {
  const player = getPlayer(state, playerId);
  if (!player || player.departed) {
    return err("PLAYER_NOT_FOUND", "You are not in this game");
  }

  if (state.phase === "lobby") {
    const remaining = state.players.filter((p) => p.id !== playerId);
    return ok({
      ...state,
      players: remaining,
      // Roster order, which in a lobby is arrival order: the seat that has been waiting
      // longest takes it over.
      hostId: playerId === state.hostId ? (remaining[0]?.id ?? state.hostId) : state.hostId,
    });
  }

  const players = updatePlayer(state.players, playerId, {
    departed: true,
    // Left where it is if they were already out: the round a seat stopped playing is
    // the round it stopped playing, and being eliminated in round 3 is not undone by
    // walking off after round 7.
    outInRound: player.outInRound ?? state.roundNumber,
  });

  /*
   * The match ends when one player is left in it (docs/rules.md §7), and a departure is
   * now one of the two ways that happens — until issue #147 every exit from `playing` went
   * through a Yaniv call. Dealing the next round to a single person is not a position the
   * rules have, so the match ends where the leaver left it: mid-round, with no scored
   * round behind it, which is a `gameEnd` the serializer already sends without a reveal.
   *
   * Not asked at `gameEnd`, where the match is over and its winner is a matter of record:
   * the last player leaving a finished match does not unwin it for them.
   *
   * `<= 1` rather than `=== 1` on `callYaniv`'s reasoning: a departure from an active
   * phase leaves at least one player in the match, two being the fewest a phase other than
   * `gameEnd` can have, and a wedged room is the wrong price for being wrong about that.
   */
  const survivors = players.filter(inMatch);
  const over = state.phase !== "gameEnd" && survivors.length <= 1;

  return ok({
    ...state,
    phase: over ? "gameEnd" : state.phase,
    players,
    round: state.phase === "playing" ? withdrawFromRound(state.round, playerId) : state.round,
    winnerIds: over ? survivors.map((p) => p.id) : state.winnerIds,
  });
}

/**
 * Take a seat out of the round being played, leaving the round playable by whoever is
 * left (issue #147).
 *
 * Four facts, and each of them is a way the round would otherwise be wrong about a player
 * who is not there:
 *
 * - The **hand goes to the buried pile**, not out of the pack. Every card dealt is still
 *   in the round, so a draw pile that empties reshuffles into as many cards as it should;
 *   dropping them would quietly shrink the deck for everyone still playing.
 * - They come out of **turn order**, which is what stops the turn ever reaching them.
 * - If the turn was **theirs**, it moves along — read off the order they were still in, so
 *   it lands on the seat that was next rather than on whoever inherited their index.
 * - Their **slapdown window** closes. It is a fact about a hand that no longer exists, and
 *   `slapDown` would find no card to put down (docs/rules.md §9).
 *
 * `lastMove`, `lastSlapdown` and the history are left exactly as they are: those moves
 * happened, and a player leaving does not unplay them.
 */
function withdrawFromRound(round: RoundState, playerId: string): RoundState {
  const { [playerId]: hand = [], ...hands } = round.hands;
  return {
    ...round,
    hands,
    buried: [...round.buried, ...hand],
    turnOrder: round.turnOrder.filter((id) => id !== playerId),
    currentTurnPlayerId:
      round.currentTurnPlayerId === playerId
        ? nextPlayerId(round)
        : round.currentTurnPlayerId,
    slapdown: round.slapdown?.playerId === playerId ? null : round.slapdown,
  };
}

/**
 * Deal the next round. The previous round's winner takes the first turn.
 *
 * Asked by anyone still in the match, rather than by one particular seat: nobody is host
 * once a round has been dealt (docs/adr/0012), and a table should not be left waiting on
 * whichever player happens to have made the room. A player the match has gone on without
 * — eliminated, or gone — is refused: they cannot rush a match they are no longer in.
 *
 * Bot-ness is not asked about, and the wire is why: a requester is identified from the
 * connection that sent this, and a bot has none, so a bot id can only ever arrive from
 * the server itself — the harness dealing a bots-only demo match, and nothing a player
 * could send.
 */
export function startNextRound(
  state: GameState,
  requesterId: string,
  rng: Rng,
): ActionResult {
  if (state.phase !== "roundEnd") {
    return err("WRONG_PHASE", "No finished round to advance from");
  }
  const requester = getPlayer(state, requesterId);
  if (!requester) {
    return err("PLAYER_NOT_FOUND", "You are not in this game");
  }
  if (!inMatch(requester)) {
    return err("NOT_IN_MATCH", "Only a player still in the match can deal the next round");
  }
  /*
   * The round's winner, where they are still in the match to take it. Scoring cannot have
   * taken them out — their delta was 0 and a reduction only subtracts (docs/rules.md §7) —
   * but *leaving* can, and does, now that a seat may be given up at a scored round
   * (issue #147). The fallback is the first seat still playing rather than the host, who
   * may be out by now: a starter absent from `turnOrder` would open a round holding no
   * hand, and hand on to nobody.
   */
  const winner = state.lastRoundResult && getPlayer(state, state.lastRoundResult.winnerId);
  const starter = winner && inMatch(winner) ? winner.id : playersInMatch(state)[0]!.id;
  return ok(dealRound(state, starter, rng));
}

// ---------------------------------------------------------------------------
// Taking a turn
// ---------------------------------------------------------------------------

function nextPlayerId(round: RoundState): string {
  const index = round.turnOrder.indexOf(round.currentTurnPlayerId);
  return round.turnOrder[(index + 1) % round.turnOrder.length]!;
}

/** Resolve requested card ids against a hand, rejecting unknown or repeated ids. */
function collectFromHand(
  hand: readonly Card[],
  cardIds: readonly string[],
): { ok: true; cards: Card[] } | { ok: false; result: ActionResult } {
  if (cardIds.length === 0) {
    return { ok: false, result: err("EMPTY_DISCARD_SET", "Must discard at least one card") };
  }
  if (new Set(cardIds).size !== cardIds.length) {
    return { ok: false, result: err("DUPLICATE_CARDS", "Duplicate card in discard") };
  }

  const cards: Card[] = [];
  for (const id of cardIds) {
    const card = hand.find((c) => c.id === id);
    if (!card) {
      return {
        ok: false,
        result: err("CARD_NOT_IN_HAND", `Card ${id} is not in your hand`),
      };
    }
    cards.push(card);
  }
  return { ok: true, cards };
}

/**
 * A whole turn as one indivisible action: discard a valid set, then draw exactly one
 * card. There is deliberately no state in which a player has discarded but not drawn.
 *
 * Sequencing note: the pickup comes from the set that was on the table when this turn
 * began — the *previous* player's discard. Whatever is left of it becomes buried, and
 * this player's discard becomes the new `lastDiscard`. docs/rules.md §5.
 */
export function takeTurn(
  state: GameState,
  playerId: string,
  action: TurnAction,
  rng: Rng,
): ActionResult {
  if (state.phase !== "playing") {
    return err("WRONG_PHASE", "No round in progress");
  }
  if (!getPlayer(state, playerId)) {
    return err("PLAYER_NOT_FOUND", "You are not in this game");
  }
  const round = state.round;
  if (round.currentTurnPlayerId !== playerId) {
    return err("NOT_YOUR_TURN", "It is not your turn");
  }

  const hand = round.hands[playerId] ?? [];

  const collected = collectFromHand(hand, action.discardCardIds);
  if (!collected.ok) return collected.result;
  if (!isValidSet(collected.cards)) {
    return err(
      "INVALID_SET",
      "Discard must be one card, a set of equal ranks, or a same-suit run of 3+ (jokers may fill gaps in a run)",
    );
  }

  // The pile as it stood at the start of this turn — the pickup source.
  const pickupSource = round.lastDiscard;
  let drawPile = round.drawPile;
  let buried = round.buried;
  let drawnCard: Card;
  let pickupLeftovers: Card[];

  if (action.draw.source === "deck") {
    if (drawPile.length === 0) {
      // Reshuffle the buried cards. The set currently on the table stays put.
      if (buried.length === 0) {
        return err("DECK_EXHAUSTED", "No cards left to draw");
      }
      drawPile = shuffle(buried, rng);
      buried = [];
    }
    drawnCard = drawPile[0]!;
    drawPile = drawPile.slice(1);
    pickupLeftovers = pickupSource;
  } else {
    if (pickupSource.length === 0) {
      return err("DISCARD_PILE_EMPTY", "There is nothing to pick up");
    }
    const wanted = action.draw.cardId;
    const eligible = pickupCandidates(pickupSource);
    const picked = eligible.find((c) => c.id === wanted);
    if (!picked) {
      return err(
        "CARD_NOT_PICKUP_ELIGIBLE",
        "Only the first or last card of the last discard can be taken",
      );
    }
    drawnCard = picked;
    pickupLeftovers = pickupSource.filter((c) => c.id !== wanted);
  }

  const discardedIds = new Set(action.discardCardIds);
  const newHand = [...hand.filter((c) => !discardedIds.has(c.id)), drawnCard];

  const discarded = canonicalizeSet(collected.cards);

  const newRound: RoundState = {
    ...round,
    hands: { ...round.hands, [playerId]: newHand },
    drawPile,
    buried: [...buried, ...pickupLeftovers],
    lastDiscard: discarded,
    currentTurnPlayerId: nextPlayerId(round),
    // Always assigned, never merged: whatever window the previous player was left with
    // closes here whether or not this turn opens one of its own. docs/rules.md §9.
    slapdown: opensSlapdown(collected.cards, action.draw.source, drawnCard)
      ? { playerId, card: drawnCard }
      : null,
    // Recorded here and nowhere else: this is the only transition that draws a card, and
    // the only place the identity of the drawn one is still known. What the serializer
    // then tells each viewer about it is a separate question.
    lastMove: { playerId, drawSource: action.draw.source, drawnCard },
    // The same move again, kept rather than overwritten. The discard is carried here and
    // not on `lastMove` because `lastDiscard` answers that for the latest move alone.
    moveHistory: [
      ...round.moveHistory,
      {
        kind: "turn",
        playerId,
        discarded,
        drawSource: action.draw.source,
        drawnCard,
      },
    ],
  };

  return ok({ ...state, round: newRound });
}

/**
 * Put the card just drawn straight back down on the set it matches, out of turn.
 * docs/rules.md §9.
 *
 * Not a turn and not a variation on one: the turn moved to the next player the moment
 * the `takeTurn` that opened this window resolved, and it stays there. All this does is
 * shrink the slapper's hand by the card they never really got to keep.
 *
 * Whether the window is open is the whole of the rule — `takeTurn` already decided that
 * (`opensSlapdown`), and the next player's turn closes it — so there is nothing here to
 * ask about the cards. The card is guaranteed still in hand: its owner has not been able
 * to act since it was dealt to them, and whatever would have let them act closes the
 * window first.
 */
export function slapDown(state: GameState, playerId: string): ActionResult {
  if (state.phase !== "playing") {
    return err("WRONG_PHASE", "No round in progress");
  }
  const round = state.round;
  const window = round.slapdown;
  if (!window || window.playerId !== playerId) {
    return err("SLAPDOWN_NOT_AVAILABLE", "You have nothing to slap down");
  }

  const hand = round.hands[playerId] ?? [];

  const newRound: RoundState = {
    ...round,
    hands: { ...round.hands, [playerId]: hand.filter((c) => c.id !== window.card.id) },
    lastDiscard: [...round.lastDiscard, window.card],
    slapdown: null,
    // The slapdown's own fact, beside the card landing on the pile: which seat it came
    // out of is not otherwise recoverable, an open window being private to its holder.
    // `lastMove` is left standing — this is not a turn and records no draw. docs/adr/0008.
    lastSlapdown: { playerId, card: window.card },
    // And the same slapdown as a line in the round's log, between the turn that opened
    // the window and whichever turn closes it.
    moveHistory: [
      ...round.moveHistory,
      { kind: "slapdown", playerId, card: window.card },
    ],
  };

  return ok({ ...state, round: newRound });
}

// ---------------------------------------------------------------------------
// Calling Yaniv and scoring
// ---------------------------------------------------------------------------

/**
 * Players other than the caller, ordered starting from the seat after the caller.
 * This ordering is the Assaf tie-break. docs/rules.md §6.
 */
function opponentsInTurnOrder(round: RoundState, callerId: string): string[] {
  const start = round.turnOrder.indexOf(callerId);
  const ordered: string[] = [];
  for (let i = 1; i < round.turnOrder.length; i++) {
    ordered.push(round.turnOrder[(start + i) % round.turnOrder.length]!);
  }
  return ordered;
}

/**
 * End the round. The caller scores 0 if unopposed; if any opponent is at or below the
 * caller's value it is an Assaf, and the caller takes their hand value + 30 while the
 * Assafer scores 0. docs/rules.md §6.
 */
export function callYaniv(state: GameState, playerId: string): ActionResult {
  if (state.phase !== "playing") {
    return err("WRONG_PHASE", "No round in progress");
  }
  if (!getPlayer(state, playerId)) {
    return err("PLAYER_NOT_FOUND", "You are not in this game");
  }
  const round = state.round;
  if (round.currentTurnPlayerId !== playerId) {
    return err("NOT_YOUR_TURN", "It is not your turn");
  }

  const callerHand = round.hands[playerId] ?? [];
  const callerValue = handValue(callerHand);
  if (!canCallYaniv(callerHand, state.settings.yanivThreshold)) {
    return err(
      "YANIV_THRESHOLD_NOT_MET",
      `Hand must be worth ${state.settings.yanivThreshold} or less to call Yaniv (yours is ${callerValue})`,
    );
  }

  const opponents = opponentsInTurnOrder(round, playerId);
  const values = new Map<string, number>();
  for (const id of round.turnOrder) {
    values.set(id, handValue(round.hands[id] ?? []));
  }

  // Ties favour the Assafer, so `<=`. Lowest value wins; the seat-order walk above
  // makes `find` a stable tie-break without a secondary sort.
  let assaferId: string | null = null;
  let bestValue = Number.POSITIVE_INFINITY;
  for (const id of opponents) {
    const value = values.get(id)!;
    if (value <= callerValue && value < bestValue) {
      assaferId = id;
      bestValue = value;
    }
  }

  const results: PlayerRoundResult[] = [];
  const scores = new Map(state.players.map((p) => [p.id, p.score]));

  for (const id of round.turnOrder) {
    const value = values.get(id)!;
    let delta: number;
    if (id === playerId) {
      delta = assaferId === null ? 0 : value + ASSAF_PENALTY;
    } else if (id === assaferId) {
      delta = 0;
    } else {
      delta = value;
    }
    let scoreAfter = scores.get(id)! + delta;
    // The round winner (delta === 0) never re-triggers a reduction, even sitting on a
    // multiple already — a milestone is crossed, not merely occupied.
    const milestoneReduction =
      delta > 0 && scoreAfter % MILESTONE_INTERVAL === 0 ? MILESTONE_REDUCTION : 0;
    scoreAfter -= milestoneReduction;
    scores.set(id, scoreAfter);
    results.push({
      playerId: id,
      name: getPlayer(state, id)?.name ?? "",
      hand: round.hands[id] ?? [],
      handValue: value,
      delta,
      milestoneReduction,
      scoreAfter,
    });
  }

  const roundResult: RoundResult = {
    roundNumber: state.roundNumber,
    callerId: playerId,
    assaferId,
    winnerId: assaferId ?? playerId,
    players: results,
  };

  /*
   * Scores land, then elimination is read off them — in that order and no other, because
   * the milestone reduction is already folded into `scoreAfter` above and §7 puts it
   * before the comparison: a total landing exactly on a milestone is reduced first, and
   * so can be rescued by it.
   *
   * A player already out keeps everything: their total is frozen, and the round they went
   * out in is not rewritten by a later round they took no part in.
   */
  const newPlayers = state.players.map((p) => {
    if (!inMatch(p)) return p;
    const score = scores.get(p.id)!;
    return {
      ...p,
      score,
      outInRound: score > state.settings.maxScore ? state.roundNumber : null,
    };
  });

  const survivors = newPlayers.filter(inMatch);
  /*
   * The match ends when one player is left, and that player wins — not the lowest total.
   * `<= 1` rather than `=== 1` guards a position the rules say is unreachable (§7: the
   * round's winner scores 0 and reductions only subtract, so no round can empty the
   * match) — the cost of being wrong about that is a wedged room, and one player short
   * of a table is over either way.
   */
  const over = survivors.length <= 1;

  return ok({
    ...state,
    phase: over ? "gameEnd" : "roundEnd",
    // The call is the next player's turn, so it closes whatever window the previous one
    // was left holding — and a scored round has no out-of-turn move left in it anyway.
    round: { ...round, slapdown: null },
    players: newPlayers,
    lastRoundResult: roundResult,
    winnerIds: over ? survivors.map((p) => p.id) : null,
  });
}
