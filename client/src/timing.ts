/**
 * How long the moving parts of a move last, as one chain rather than a handful of numbers.
 *
 * Every duration below the first is a fraction of the one above it (issue #95), so the whole
 * table is retuned by editing one value: slow a flight down and the slapdown slows with it,
 * and the jolt behind it with that. A second constant tuned to look right beside the first
 * would be right only until somebody changed the first.
 *
 * The chain and what each link answers for:
 *
 *   FLIGHT_MS    how long a card takes to cross the table
 *   SLAP_MS      the same journey, made in anger
 *   SHAKE_MS     how long the table is still ringing from it
 *
 * Pure arithmetic and nothing else — no element, no clock, no preference — so the derivations
 * are asserted by a test with no DOM near it, which is the whole reason they live here rather
 * than beside the animation that runs them.
 */

/**
 * How long a card is in the air.
 *
 * The top of the chain and derived from nothing: what keeps a flight from being replaced
 * before it finishes is the server's bot think time, which is several times this and is a
 * fact about the game rather than about the animation. A network that bunches two
 * broadcasts can cut a flight short — cosmetic, accepted, and only on a connection that has
 * already stuttered.
 *
 * Long enough to be seen and short enough that a player who already knows what they played
 * never waits on it. They never wait on it in any case: the turn is sent, acked and drawn
 * regardless of what is in the air.
 */
export const FLIGHT_MS = 300;

/**
 * The same distance, half the time: a slapdown is a card thrown down rather than played
 * (docs/rules.md §9), and how fast it crosses is most of what says so.
 *
 * Half is the ratio because the difference has to be legible without being a different
 * animation — a card that arrived at a quarter of the time would read as a glitch, and one at
 * three quarters as the same discard. What it is a half *of* is the point: the sharpness is a
 * fact about a slapdown relative to a turn, not a speed of its own.
 */
export const SLAP_MS = FLIGHT_MS / 2;

/**
 * How long the table jolts for once the card lands — two thirds of the flight that caused it,
 * so the jolt is over before a player's eye has left the pile.
 *
 * Derived from the slap and not the flight, because it is the *slap's* aftershock: a slapdown
 * made quicker should ring for less time, not the same time.
 */
export const SHAKE_MS = (SLAP_MS * 2) / 3;
