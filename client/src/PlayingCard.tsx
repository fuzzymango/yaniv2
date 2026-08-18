/**
 * A card, drawn in CSS.
 *
 * No image assets anywhere in this client, so a card is a rank, a suit glyph and a
 * border. That keeps a hand legible at any size a phone hands it — the shape scales with
 * a font size rather than resampling a bitmap — and it is the reason `styles.css` says
 * cards are drawn rather than loaded.
 *
 * Purely presentational: it renders the card it is given and knows nothing about
 * selection, legality or whose turn it is. What a card *means* is the caller's business,
 * because the same card is a hand card here and a face-up pickup two elements away.
 */

import type { Card, Suit } from "@yaniv/shared";

const GLYPH: Record<Suit, string> = {
  hearts: "♥",
  diamonds: "♦",
  clubs: "♣",
  spades: "♠",
};

const RANK_NAME: Partial<Record<Card["rank"], string>> = {
  A: "ace",
  J: "jack",
  Q: "queen",
  K: "king",
};

/**
 * How a card is said aloud, for the controls that wrap one.
 *
 * A button's own text would otherwise be read as "7 ♥", which is what the glyph is for
 * and not what it means. Exported because the label belongs to the tappable thing, not
 * to the card inside it — a button's `aria-label` replaces its contents outright.
 */
export function cardLabel(card: Card): string {
  // The suit is already its own word on the wire; only the face ranks need spelling out.
  if (card.suit === null) return "joker";
  return `${RANK_NAME[card.rank] ?? card.rank} of ${card.suit}`;
}

/**
 * Every card says which card it is, in the markup as well as on its face.
 *
 * The one thing here that is not about drawing a card: it is how the flight layer finds a
 * card on the screen to measure (`CardsInFlight.tsx`). Still nothing about what a card
 * *means* — an id is the card's own name, and the same name in a hand, on the pile and in
 * a reveal, which is exactly what makes one place answerable from another.
 *
 * **`mini` is the one variant, and it is deliberately two things at once** (issue #91): a
 * card drawn at the size of an icon, and a card that gives up its id. A mini card is a
 * *picture* of a card rather than the card itself — it is drawn in the move history, where
 * the very same card is quite likely also sitting on the felt. Two elements answering to one
 * id would leave the flight layer measuring whichever of them it walked into last
 * (`measure` in `CardsInFlight.tsx`), so a picture carries no name: never measured, never
 * flown, and never a place left empty for an arrival.
 */
export function PlayingCard({ card, mini = false }: { card: Card; mini?: boolean }) {
  // The size and the id are one choice, made once here rather than twice below, so the two
  // faces a card can have cannot end up disagreeing about what a mini one is.
  const size = mini ? " card--mini" : "";
  const id = mini ? undefined : card.id;

  // A joker has no suit and no rank worth printing in a corner, so it is its own face
  // rather than a card with two fields left blank.
  if (card.suit === null) {
    return (
      <span className={`card card--joker${size}`} data-card-id={id}>
        <span className="card__suit">★</span>
      </span>
    );
  }

  const red = card.suit === "hearts" || card.suit === "diamonds";
  return (
    <span className={`card ${red ? "card--red" : "card--black"}${size}`} data-card-id={id}>
      <span className="card__rank">{card.rank}</span>
      <span className="card__suit">{GLYPH[card.suit]}</span>
    </span>
  );
}
