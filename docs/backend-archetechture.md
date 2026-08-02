Build and test top-down, in this order. Don't touch Socket.io until the layers below it are unit tested.

---

## 1. Card model

```typescript
// types.ts
type Suit = "hearts" | "diamonds" | "clubs" | "spades" | null; // null for jokers
type Rank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K" | "Joker";

interface Card {
  id: string;    // unique per physical card, e.g. "hearts-K" or "joker-1"
  suit: Suit;
  rank: Rank;
  value: number; // numeric value for scoring
}
```

**Decisions to make explicitly:**
- `id` as `suit-rank` only works for a single deck. If multi-deck support is ever added, switch to a UUID or incrementing counter to avoid id collisions.
- Joker value (0? high value like 50?) is a property on the card itself, not a special case scattered through game logic.

---

## 2. Deck (draw pile)

```typescript
class Deck {
  private cards: Card[];

  constructor() {
    this.cards = this.buildFullDeck();
    this.shuffle();
  }

  private buildFullDeck(): Card[] {
    const suits: Suit[] = ["hearts", "diamonds", "clubs", "spades"];
    const ranks: Rank[] = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
    const cards: Card[] = [];

    for (const suit of suits) {
      for (const rank of ranks) {
        cards.push({ id: `${suit}-${rank}`, suit, rank, value: rankToValue(rank) });
      }
    }
    cards.push({ id: "joker-1", suit: null, rank: "Joker", value: 0 });
    cards.push({ id: "joker-2", suit: null, rank: "Joker", value: 0 });
    return cards;
  }

  private shuffle(): void {
    // Fisher-Yates
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  draw(count: number = 1): Card[] {
    return this.cards.splice(0, count);
  }

  get remainingCount(): number {
    return this.cards.length;
  }

  reshuffleFrom(cards: Card[]): void {
    this.cards = cards;
    this.shuffle();
  }
}
```

## Discard pile

No dedicated class needed — just `Card[]` where the last element is the top (face up, visible to all):

```typescript
discardPile: Card[]; // last element = top of pile
```

---

## 3. Player model

```typescript
interface Player {
  id: string;   // socket.id, or a stable player id if reconnect support is added later
  name: string;
  score: number;
  hand: Card[];
}
```

---

## 4. Game state

```typescript
interface GameState {
  roomCode: string;
  players: Player[];
  drawPile: Card[];        // server's full view
  discardPile: Card[];
  currentTurnPlayerId: string;
  turnOrder: string[];
}
```

**Important:** `GameState` as defined here is the *server's* full view. Clients must never receive it directly — see "Client serialization" below.

---

## 5. Core actions — pure functions

Return new state rather than mutating in place. Not required for a Node backend the way it is in React, but it makes these trivial to unit test: pass in a state, assert on the returned state, no hidden side effects between tests.

```typescript
// game.ts

function playCards(state: GameState, playerId: string, cardIds: string[]): GameState {
  const player = getPlayer(state, playerId);
  if (state.currentTurnPlayerId !== playerId) throw new Error("Not your turn");

  const cardsToPlay = player.hand.filter(c => cardIds.includes(c.id));
  if (cardsToPlay.length !== cardIds.length) throw new Error("Card not in hand");

  if (!isValidPlaySet(cardsToPlay, state)) throw new Error("Invalid play");

  const newHand = player.hand.filter(c => !cardIds.includes(c.id));
  const newDiscardPile = [...state.discardPile, ...cardsToPlay];

  return advanceTurn({
    ...state,
    players: updatePlayer(state.players, playerId, { hand: newHand }),
    discardPile: newDiscardPile,
  });
}

function drawFromPile(state: GameState, playerId: string, source: "draw" | "discard"): GameState {
  const player = getPlayer(state, playerId);
  if (state.currentTurnPlayerId !== playerId) throw new Error("Not your turn");

  let drawnCard: Card;
  let newDrawPile = [...state.drawPile];
  let newDiscardPile = [...state.discardPile];

  if (source === "draw") {
    if (newDrawPile.length === 0) {
      // reshuffle discard (minus top card) into draw pile
      const topCard = newDiscardPile.pop()!;
      newDrawPile = shuffleArray(newDiscardPile);
      newDiscardPile = [topCard];
    }
    drawnCard = newDrawPile.shift()!;
  } else {
    if (newDiscardPile.length === 0) throw new Error("Discard pile is empty");
    drawnCard = newDiscardPile.pop()!;
  }

  return {
    ...state,
    drawPile: newDrawPile,
    discardPile: newDiscardPile,
    players: updatePlayer(state.players, playerId, { hand: [...player.hand, drawnCard] }),
  };
}
```

`isValidPlaySet` is where the actual game rules live (e.g. Yaniv's "same rank" or "run of consecutive same-suit cards" rules) — keep it as its own pure function, heavily unit tested, since it's where most of the interesting bugs will be.

---

## 6. Room manager (multi-room support)

```typescript
class RoomManager {
  private rooms = new Map<string, GameState>();

  createRoom(hostPlayer: Player): string {
    const roomCode = generateRoomCode(); // e.g. 4-char alphanumeric, check for collisions
    const deck = new Deck();
    this.rooms.set(roomCode, {
      roomCode,
      players: [hostPlayer],
      drawPile: deck.draw(deck.remainingCount),
      discardPile: [],
      currentTurnPlayerId: hostPlayer.id,
      turnOrder: [hostPlayer.id],
    });
    return roomCode;
  }

  getRoom(roomCode: string): GameState | undefined {
    return this.rooms.get(roomCode);
  }

  updateRoom(roomCode: string, newState: GameState): void {
    this.rooms.set(roomCode, newState);
  }

  removeRoom(roomCode: string): void {
    this.rooms.delete(roomCode);
  }
}
```

Each `roomCode` maps to a fully independent `GameState`. The Socket.io layer stays thin: look up the room, call a pure function, store the result, broadcast it.

---

## 7. Client serialization (security-relevant — do this early)

`GameState` includes every card in every player's hand and the full draw pile order. That's the server's view only. Broadcasting it as-is lets anyone inspect network traffic in browser dev tools and see other players' hands and the draw pile order.

Build a per-player view function before wiring up sockets:

```typescript
function serializeStateForPlayer(state: GameState, viewerPlayerId: string) {
  return {
    roomCode: state.roomCode,
    players: state.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      // full hand only for the viewer; everyone else just gets a count
      hand: p.id === viewerPlayerId ? p.hand : undefined,
      handSize: p.hand.length,
    })),
    drawPileCount: state.drawPile.length, // never send actual draw pile cards
    discardPile: state.discardPile,       // discard is face-up, fine to send in full
    currentTurnPlayerId: state.currentTurnPlayerId,
    turnOrder: state.turnOrder,
  };
}
```

Call this per-socket when broadcasting `gameStateUpdate`, not `io.to(roomCode).emit(...)` with the raw state.

---

## Socket.io event contract (reference)

```typescript
interface ClientToServerEvents {
  createRoom: (playerName: string, callback: (roomCode: string) => void) => void;
  joinRoom: (roomCode: string, playerName: string) => void;
  playCards: (cardIds: string[]) => void;
  drawCard: (source: "draw" | "discard") => void;
}

interface ServerToClientEvents {
  gameStateUpdate: (state: ReturnType<typeof serializeStateForPlayer>) => void;
  playerJoined: (playerName: string) => void;
  errorMessage: (message: string) => void;
}
```

---

## Build order

1. `types.ts` — Card, Player, GameState interfaces
2. `Deck` class + unit tests (shuffle, draw, reshuffle-from-discard)
3. Pure game logic (`playCards`, `drawFromPile`, `isValidPlaySet`) + unit tests
4. `serializeStateForPlayer` + unit tests
5. `RoomManager`
6. Socket.io wiring (`server.ts`, event handlers) — thin layer calling into 1-5
7. Scripted test-client (multiple terminal tabs simulating players) for end-to-end checks
8. Only then: React frontend