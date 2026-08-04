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

export function PlayingCard({ card }: { card: Card }) {
  // A joker has no suit and no rank worth printing in a corner, so it is its own face
  // rather than a card with two fields left blank.
  if (card.suit === null) {
    return (
      <span className="card card--joker">
        <span className="card__suit">★</span>
      </span>
    );
  }

  const red = card.suit === "hearts" || card.suit === "diamonds";
  return (
    <span className={`card ${red ? "card--red" : "card--black"}`}>
      <span className="card__rank">{card.rank}</span>
      <span className="card__suit">{GLYPH[card.suit]}</span>
    </span>
  );
}
