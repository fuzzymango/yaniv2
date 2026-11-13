/**
 * Whether a scored round has a milestone count to play, whose seats it counts at, and what
 * each of their lines says at any moment of it.
 *
 * Pure fixtures in, a count or nothing out — `announcement.test.ts`'s shape, and on purpose
 * its trigger: the count starts on exactly the publications the banners do (spec #280).
 * Nothing about pixels, frames or timing is decided by `countdownFrom`, so nothing about
 * them is asserted here either.
 *
 * As with the announcement, the cases that matter most are about *freshness*: a scored
 * round is republished by several paths, and a count read off anything but the scorecard
 * growing would start again on every one of them.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  PlayerGameView,
  PlayerRoundResultView,
  PlayerRoundScore,
  RoundResultView,
  RoundScore,
} from "@yaniv/shared";
import type { LatchedCount } from "../src/milestone.ts";
import {
  countFrame,
  countLive,
  countdownFrom,
  isCounting,
  latchCount,
  outShownFor,
  pulseScale,
  ringFrame,
} from "../src/milestone.ts";
import { scoreLabel } from "../src/score.ts";
import {
  MILESTONE_COUNT_MS,
  MILESTONE_PULSE_MS,
  MILESTONE_RING_FADE_MS,
  MILESTONE_RING_MS,
} from "../src/timing.ts";
import { cards, viewOf } from "./helpers.ts";

/** One seat's line in a scorecard row: where the round left it, and what a milestone took off. */
const line = (playerId: string, scoreAfter: number, milestoneReduction = 0): PlayerRoundScore => ({
  playerId,
  scoreAfter,
  milestoneReduction,
});

/** A scorecard row, named by who called it and who took it off them. */
const row = (
  roundNumber: number,
  players: PlayerRoundScore[],
  callerId = "p1",
  assaferId: string | null = null,
): RoundScore => ({ roundNumber, callerId, assaferId, players });

/** The rows a table is drawn from when nobody hit a milestone. */
const plain = (roundNumber: number): RoundScore => row(roundNumber, [line("p1", 10), line("p2", 20)]);

/**
 * The reveal standing beside a scorecard. Deliberately *not* the newest row: it is the
 * field a count must not be read from, so every fixture leaves it saying something else —
 * here, a milestone of its own — and a `countdownFrom` that reached for it would count it.
 */
const staleReveal: RoundResultView = {
  roundNumber: 1,
  callerId: "p1",
  assaferId: null,
  winnerId: "p1",
  players: [
    { playerId: "p1", name: "Ada", hand: cards("hearts-5"), handValue: 5, delta: 0, milestoneReduction: 0, scoreAfter: 10 },
    { playerId: "p2", name: "Grace", hand: cards("spades-9"), handValue: 30, delta: 30, milestoneReduction: 50, scoreAfter: 0 },
  ],
};

/** A position mid-round: nothing new scored. */
const playing = (scorecard: RoundScore[] = []): PlayerGameView => ({
  ...viewOf(cards("hearts-5"), cards("clubs-7")),
  scorecard,
});

/** A position with a round on the table, scored and revealed. */
const scored = (scorecard: RoundScore[], phase: "roundEnd" | "gameEnd" = "roundEnd"): PlayerGameView => ({
  ...playing(scorecard),
  phase,
  roundResult: staleReveal,
});

describe("countdownFrom", () => {
  describe("counts", () => {
    it("a lone milestone, from the multiple it landed on to where the round left it", () => {
      const after = scored([row(1, [line("p1", 10), line("p2", 0, 50)])]);

      assert.deepEqual(countdownFrom(playing(), after), {
        round: 1,
        phase: "roundEnd",
        seats: [{ playerId: "p2", landedOn: 50, settlesOn: 0 }],
      });
    });

    it("every milestone seat at once, the viewer's own included, in the row's order", () => {
      const before = playing([plain(1)]);
      const after = scored([
        plain(1),
        row(2, [line("p1", 50, 50), line("p2", 0, 50), line("p3", 37)]),
      ]);

      assert.deepEqual(countdownFrom(before, after), {
        round: 2,
        phase: "roundEnd",
        seats: [
          { playerId: "p1", landedOn: 100, settlesOn: 50 },
          { playerId: "p2", landedOn: 50, settlesOn: 0 },
        ],
      });
    });

    it("an Assafed caller who hit a milestone, under the banner that took the call off them", () => {
      const after = scored([row(1, [line("p1", 0, 50), line("p2", 0)], "p1", "p2")]);

      assert.deepEqual(countdownFrom(playing(), after), {
        round: 1,
        phase: "roundEnd",
        seats: [{ playerId: "p1", landedOn: 50, settlesOn: 0 }],
      });
    });

    it("the round that ends the match, at gameEnd", () => {
      // The phase is never asked: a milestone in the deciding round arrives as a `gameEnd`,
      // and a trigger that named `roundEnd` would leave it the one milestone never counted.
      const before = playing([plain(1)]);
      const after = scored([plain(1), row(2, [line("p1", 50, 50), line("p2", 104)])], "gameEnd");

      assert.deepEqual(countdownFrom(before, after), {
        round: 2,
        phase: "gameEnd",
        seats: [{ playerId: "p1", landedOn: 100, settlesOn: 50 }],
      });
    });
  });

  describe("null", () => {
    it("on a position nobody watched arrive — a cold boot or a seat claimed back", () => {
      const after = scored([row(1, [line("p1", 10), line("p2", 0, 50)])]);
      assert.equal(countdownFrom(null, after), null);
    });

    it("on a republication of the same scored round", () => {
      // A drop, a reconnect or a departure that leaves the match going all republish the
      // round on the table. The scorecard has not grown, so nothing has been scored.
      const card = [row(1, [line("p1", 10), line("p2", 0, 50)])];
      assert.equal(countdownFrom(scored(card), scored(card)), null);
    });

    it("on a deal", () => {
      const card = [row(1, [line("p1", 10), line("p2", 0, 50)])];
      assert.equal(countdownFrom(scored(card), playing(card)), null);
    });

    it("on a match ended by a departure", () => {
      // `gameEnd` with no round scored to reach it: the last row and the reveal beside it
      // are both still standing, and neither is news.
      const card = [row(1, [line("p1", 10), line("p2", 0, 50)])];
      assert.equal(countdownFrom(scored(card), scored(card, "gameEnd")), null);
    });

    it("on a round nobody hit a milestone in", () => {
      assert.equal(countdownFrom(playing([plain(1)]), scored([plain(1), plain(2)])), null);
    });

    it("on a round in which the reveal beside the scorecard has a milestone and the row does not", () => {
      // Content and trigger come off the one row. The reveal fixture carries a milestone
      // for p2; the row scored here does not, so there is nothing to count.
      assert.equal(countdownFrom(playing(), scored([plain(1)])), null);
    });
  });
});

/**
 * Whether a count the table latched is still running on the position now on the screen.
 * `countdownFrom` decides when a count starts, and this decides when it ends. Both questions
 * are about a scored round being republished by several paths, and only some of those paths
 * should stop the count.
 */
describe("countLive", () => {
  const card = [plain(1), row(2, [line("p1", 10), line("p2", 0, 50)])];
  const latchedAt = (view: PlayerGameView) => {
    const count = countdownFrom(playing([plain(1)]), view);
    assert.ok(count !== null, "a fixture with a count to latch");
    return count;
  };

  it("runs on through a republication of the round it was scored in", () => {
    // A drop, a reconnect, a departure that leaves the match going: same round, same phase.
    assert.equal(countLive(latchedAt(scored(card)), scored(card)), true);
  });

  it("runs on at gameEnd when the round that ended the match is the one counting", () => {
    assert.equal(countLive(latchedAt(scored(card, "gameEnd")), scored(card, "gameEnd")), true);
  });

  it("ends on a deal, the scorecard unchanged", () => {
    assert.equal(countLive(latchedAt(scored(card)), playing(card)), false);
  });

  it("ends on a departure that ends the match, which reveals the same round again", () => {
    // `gameEnd` with no new row, and the table stays mounted under the standings, so the
    // only thing that has changed is the phase.
    assert.equal(countLive(latchedAt(scored(card)), scored(card, "gameEnd")), false);
  });

  it("ends once a later round is scored", () => {
    const later = [...card, plain(3)];
    assert.equal(countLive(latchedAt(scored(card)), scored(later)), false);
  });
});

/**
 * The table's latch, render by render (spec #280's "Lifetime"). Each step is one render of the
 * table: the latch it held, the snapshot's countdown and view, and what it holds after. A
 * countdown is a one-shot — non-null on the publication that scored the round, null on every
 * one after — so the sequences below are the session's, played into the table.
 */
describe("latchCount", () => {
  const card = [plain(1), row(2, [line("p1", 10), line("p2", 0, 50)])];
  const arrive = (from: PlayerGameView, to: PlayerGameView) => {
    const count = countdownFrom(from, to);
    assert.ok(count !== null, "a fixture with a count to latch");
    return count;
  };

  /** A `start` that hands out increasing moments and counts how often it was asked. */
  const clock = () => {
    let asked = 0;
    const start = () => {
      asked += 1;
      return { startedAt: asked * 1000, still: false };
    };
    return { start, asked: () => asked };
  };

  it("latches a countdown it has not seen, asking for the moment once", () => {
    const { start, asked } = clock();
    const view = scored(card);
    const countdown = arrive(playing([plain(1)]), view);
    const latch = latchCount(null, countdown, view, start);
    assert.deepEqual(latch, { count: countdown, startedAt: 1000, still: false });
    assert.equal(asked(), 1);
  });

  it("carries the reduced-motion answer it was handed at the latch", () => {
    const view = scored(card);
    const countdown = arrive(playing([plain(1)]), view);
    const latch = latchCount(null, countdown, view, () => ({ startedAt: 5, still: true }));
    assert.equal(latch?.still, true);
  });

  it("keeps the latch, the very same one, on a re-render of the snapshot that brought it", () => {
    // Same snapshot, same countdown object: a selection toggled, a toast arriving.
    const { start, asked } = clock();
    const view = scored(card);
    const countdown = arrive(playing([plain(1)]), view);
    const latch = latchCount(null, countdown, view, start);
    assert.equal(latchCount(latch, countdown, view, start), latch);
    assert.equal(asked(), 1, "never restarted");
  });

  it("keeps the latch through a republication of the same round, its start untouched", () => {
    // A peer drops: the one-shot is cleared, the round is the same.
    const { start, asked } = clock();
    const view = scored(card);
    const latch = latchCount(null, arrive(playing([plain(1)]), view), view, start);
    const after = latchCount(latch, null, scored(card), start);
    assert.equal(after, latch);
    assert.equal(after?.startedAt, 1000);
    assert.equal(asked(), 1);
  });

  it("drops the latch on a deal", () => {
    const { start } = clock();
    const view = scored(card);
    const latch = latchCount(null, arrive(playing([plain(1)]), view), view, start);
    assert.equal(latchCount(latch, null, playing(card), start), null);
  });

  it("drops the latch on a departure that ends the match from roundEnd", () => {
    const { start } = clock();
    const view = scored(card);
    const latch = latchCount(null, arrive(playing([plain(1)]), view), view, start);
    assert.equal(latchCount(latch, null, scored(card, "gameEnd"), start), null);
  });

  it("is never revived once dropped, even by a later position that shares its key", () => {
    // A rematch that ends on as many rounds as this match did, at roundEnd again: the key
    // matches the old latch, but the table already let it go, and no countdown came with it.
    const { start, asked } = clock();
    const view = scored(card);
    const latch = latchCount(null, arrive(playing([plain(1)]), view), view, start);
    const dealt = latchCount(latch, null, playing(card), start);
    assert.equal(dealt, null);
    assert.equal(latchCount(dealt, null, scored(card), start), null);
    assert.equal(asked(), 1);
  });

  it("replaces a stale latch with a new countdown, asking for a new moment", () => {
    const { start } = clock();
    const first = scored(card);
    const old = latchCount(null, arrive(playing([plain(1)]), first), first, start);
    const later = scored([...card, row(3, [line("p1", 0, 50), line("p2", 20)])]);
    const countdown = arrive(playing(card), later);
    const latch = latchCount(old, countdown, later, start);
    assert.notEqual(latch, old);
    assert.equal(latch?.count, countdown);
    assert.equal(latch?.startedAt, 2000);
  });

  it("holds nothing where there was nothing to hold", () => {
    const { start, asked } = clock();
    assert.equal(latchCount(null, null, scored(card), start), null);
    assert.equal(asked(), 0);
  });
});

describe("isCounting", () => {
  const latched = (seats: string[]): LatchedCount => {
    const [first, ...rest] = seats.map((playerId) => ({ playerId, landedOn: 50, settlesOn: 0 }));
    assert.ok(first !== undefined);
    return { count: { round: 2, phase: "roundEnd", seats: [first, ...rest] }, startedAt: 0, still: false };
  };

  it("counts at every seat the count names, the viewer's own included", () => {
    const latch = latched(["p1", "p2", "p3"]);
    assert.deepEqual(["p1", "p2", "p3"].map((id) => isCounting(latch, id)), [true, true, true]);
  });

  it("counts at no seat the count does not name", () => {
    assert.equal(isCounting(latched(["p2"]), "p1"), false);
  });

  it("counts at no seat with no count latched", () => {
    assert.equal(isCounting(null, "p2"), false);
  });
});

describe("outShownFor", () => {
  /** p2, who stood on 20 and was caught holding 30: a milestone, and — by `wentOut` — out. */
  const lineOf = (delta: number, milestoneReduction: number): PlayerRoundResultView => ({
    playerId: "p2",
    name: "Grace",
    hand: cards("spades-9"),
    handValue: delta,
    delta,
    milestoneReduction,
    scoreAfter: 20 + delta - milestoneReduction,
  });
  const milestone = lineOf(30, 50);
  const plainLine = lineOf(7, 0);
  const latch: LatchedCount = {
    count: { round: 2, phase: "roundEnd", seats: [{ playerId: "p2", landedOn: 50, settlesOn: 0 }] },
    startedAt: 0,
    still: false,
  };

  it("withholds going out from a seat still counting", () => {
    assert.equal(outShownFor(latch, false, milestone, true), false);
  });

  it("shows it the moment the count lands", () => {
    assert.equal(outShownFor(latch, true, milestone, true), true);
  });

  it("shows it at once on a seat that went out with nothing to count", () => {
    const other: LatchedCount = {
      ...latch,
      count: { ...latch.count, seats: [{ playerId: "p3", landedOn: 50, settlesOn: 0 }] },
    };
    assert.equal(outShownFor(other, false, plainLine, true), true);
    assert.equal(outShownFor(null, false, plainLine, true), true);
  });

  it("shows nothing on a seat that did not go out, counting or not", () => {
    assert.equal(outShownFor(latch, false, milestone, false), false);
    assert.equal(outShownFor(latch, true, milestone, false), false);
  });

  it("agrees with the line's own OUT mark at the start of the count and at its end", () => {
    assert.equal(outShownFor(latch, false, milestone, true), countFrame(milestone, true, 0).outShown);
    assert.equal(
      outShownFor(latch, true, milestone, true),
      countFrame(milestone, true, MILESTONE_COUNT_MS).outShown,
    );
  });
});

/**
 * One seat's revealed line: stood on `before`, caught holding `delta`, and a milestone taking
 * 50 back where the total landed on one. `wentOut` is the caller's to say, as `Table` does.
 */
const revealed = (before: number, delta: number): PlayerRoundResultView => {
  const landed = before + delta;
  const milestoneReduction = delta > 0 && landed % 50 === 0 ? 50 : 0;
  return {
    playerId: "p2",
    name: "Grace",
    hand: cards("spades-9"),
    handValue: delta,
    delta,
    milestoneReduction,
    scoreAfter: landed - milestoneReduction,
  };
};

/** Every whole millisecond of a count, and a little either side of it. */
const throughTheCount = Array.from({ length: MILESTONE_COUNT_MS + 201 }, (_, i) => i - 100);

describe("countFrame", () => {
  // The spec's own example: on 20, caught holding 30, so 50 and back to 0.
  const ada = revealed(20, 30);

  describe("the label", () => {
    it("is unfolded at the start: where they stood, the round's raw points, the multiple landed on", () => {
      assert.deepEqual(countFrame(ada, false, 0), {
        stage: "counting",
        total: 50,
        label: "20 + 30 = 50 pts",
        lead: "20 + 30 = ",
        scale: 1,
        outShown: false,
      });
    });

    it("is unfolded and unmoved before the start — a frame stamped a moment before the latch", () => {
      // A frame's timestamp is when the frame began, which can be a hair before the table
      // latched the count; it reads as the count's first moment, never as a value past it.
      assert.equal(countFrame(ada, false, -16).label, "20 + 30 = 50 pts");
      assert.equal(countFrame(ada, false, -Infinity).total, 50);
    });

    it("drains halfway at half the count, with the fixed part of the sentence unchanged", () => {
      assert.equal(countFrame(ada, false, MILESTONE_COUNT_MS / 2).label, "20 + 30 = 25 pts");
    });

    it("drains a total of integers, never rising, from the multiple to where the round left it", () => {
      const totals = throughTheCount.map((ms) => countFrame(ada, false, ms).total);
      for (const total of totals) assert.ok(Number.isInteger(total), `${total} is a whole number`);
      for (let i = 1; i < totals.length; i += 1) {
        assert.ok(totals[i]! <= totals[i - 1]!, `${totals[i]} after ${totals[i - 1]}`);
      }
      assert.equal(totals[0], 50);
      assert.equal(totals[totals.length - 1], 0);
    });

    it("is exactly where the round left them at the count's length and beyond", () => {
      for (const ms of [MILESTONE_COUNT_MS, MILESTONE_COUNT_MS + 1, 60_000, Infinity]) {
        assert.equal(countFrame(ada, false, ms).total, ada.scoreAfter);
        assert.equal(countFrame(ada, false, ms).stage, "landed");
      }
      assert.equal(countFrame(ada, false, MILESTONE_COUNT_MS - 1).stage, "counting");
    });

    it("lands on the folded sentence every other scored line reads", () => {
      // The landing is one frame from the count to today's label, not a third wording.
      for (const player of [ada, revealed(195, 55), revealed(70, 30)]) {
        assert.equal(
          countFrame(player, false, MILESTONE_COUNT_MS).label,
          scoreLabel(player.scoreAfter, player.delta, player.milestoneReduction),
        );
      }
    });

    it("drains a total landed on a later multiple to the one below it", () => {
      const mid = revealed(195, 55); // 250, back to 200
      assert.equal(countFrame(mid, false, 0).label, "195 + 55 = 250 pts");
      assert.equal(countFrame(mid, false, MILESTONE_COUNT_MS).label, "195 + 5 = 200 pts");
    });

    it("has nothing to count on a line no milestone touched", () => {
      // Total over every line, so a seat that is not counting cannot be drawn as one.
      const plainLine = revealed(10, 7);
      assert.deepEqual(countFrame(plainLine, false, 0), {
        stage: "landed",
        total: 17,
        label: scoreLabel(17, 7, 0),
        lead: "10 + 7 = ",
        scale: 1,
        outShown: false,
      });
    });
  });

  describe("the parts the total is drawn apart from", () => {
    it("are the label, split before its total, at every moment and on every line", () => {
      // The table draws the total in a box of its own so it can throb alone; the sentence
      // around it must still read as the label does, counting or landed.
      for (const player of [ada, revealed(195, 55), revealed(10, 7), revealed(40, 25)]) {
        for (const ms of throughTheCount) {
          const frame = countFrame(player, false, ms);
          assert.equal(`${frame.lead}${frame.total} pts`, frame.label, `at ${ms}ms`);
        }
      }
    });
  });

  describe("the throb", () => {
    it("is the pulse at every moment of the count", () => {
      for (const ms of throughTheCount.filter((ms) => ms >= 0 && ms < MILESTONE_COUNT_MS)) {
        assert.equal(countFrame(ada, false, ms).scale, pulseScale(ms), `at ${ms}ms`);
      }
    });

    it("is at rest once landed", () => {
      for (const ms of [MILESTONE_COUNT_MS, MILESTONE_COUNT_MS + MILESTONE_PULSE_MS / 2, Infinity]) {
        assert.equal(countFrame(ada, false, ms).scale, 1, `at ${ms}ms`);
      }
    });

    it("is at rest before the count, never a size the count would not reach first", () => {
      // A frame stamped before the latch reads as the count's first moment, which is at rest.
      assert.equal(countFrame(ada, false, -MILESTONE_PULSE_MS / 2).scale, 1);
    });

    it("never moves a line no milestone touched", () => {
      for (const ms of throughTheCount) assert.equal(countFrame(revealed(10, 7), false, ms).scale, 1);
    });
  });

  describe("going out", () => {
    // On 195, caught holding 55: landed on 250, the milestone takes it to 200, still past 100.
    const outOnMilestone = revealed(195, 55);

    it("is withheld for the whole count from a seat the round took out", () => {
      for (const ms of throughTheCount.filter((ms) => ms < MILESTONE_COUNT_MS)) {
        assert.equal(countFrame(outOnMilestone, true, ms).outShown, false, `at ${ms}ms`);
      }
    });

    it("is shown the moment the count lands, and from then on", () => {
      assert.equal(countFrame(outOnMilestone, true, MILESTONE_COUNT_MS).outShown, true);
      assert.equal(countFrame(outOnMilestone, true, Infinity).outShown, true);
    });

    it("is shown at once on a seat that went out with no milestone to count", () => {
      assert.equal(countFrame(revealed(90, 27), true, 0).outShown, true);
    });

    it("is never shown on a seat the milestone saved", () => {
      // On 120, caught holding 30: 150 back to 100, which is not past the limit.
      const saved = revealed(120, 30);
      for (const ms of throughTheCount) assert.equal(countFrame(saved, false, ms).outShown, false);
    });
  });
});

describe("pulseScale", () => {
  it("is at rest at the start of a throb", () => {
    assert.equal(pulseScale(0), 1);
  });

  it("is at its largest, 1.1, half a throb in", () => {
    assert.equal(pulseScale(MILESTONE_PULSE_MS / 2), 1.1);
  });

  it("rises and falls between those two and nowhere else", () => {
    for (let ms = 0; ms <= MILESTONE_PULSE_MS; ms += 1) {
      const scale = pulseScale(ms);
      assert.ok(scale >= 1 && scale <= 1.1, `${scale} at ${ms}ms`);
    }
  });

  it("repeats every throb, steadily", () => {
    // A steady 4Hz (spec #280): the same size at the same point of every period.
    for (let ms = 0; ms < MILESTONE_COUNT_MS; ms += 7) {
      for (const periods of [1, 2, 5]) {
        const later = pulseScale(ms + periods * MILESTONE_PULSE_MS);
        assert.ok(Math.abs(later - pulseScale(ms)) < 1e-9, `${ms}ms and ${periods} throbs on`);
      }
    }
  });
});

/*
 * The laser ring traced once round a counting seat's namecard (spec #280). Positions are
 * percentages of the namecard's perimeter — the component hands them to rects carrying
 * `pathLength="100"`, so the browser does the arithmetic and nothing is measured — and every
 * number asserted here is the shape variant A was judged on (#279): a 28-segment trail falling
 * off over 80% of the lap, white for its first seventh.
 */
describe("ringFrame", () => {
  /** A frame that has to exist: the ring is on the screen until its lap and its fade are over. */
  const at = (elapsedMs: number) => {
    const frame = ringFrame(elapsedMs);
    assert.ok(frame !== null, `a ring ${elapsedMs}ms into the count`);
    return frame;
  };

  it("has traced nothing at the count's first moment, nor before it", () => {
    for (const ms of [0, -16]) {
      assert.equal(at(ms).head, null, `no head at ${ms}ms`);
      assert.deepEqual(at(ms).trail, [], `no trail at ${ms}ms`);
    }
  });

  it("carries its head round the namecard once, eased in and out", () => {
    assert.ok(Math.abs(at(MILESTONE_RING_MS / 2).head!.to - 50) < 1e-9, "half the lap at half the time");
    assert.equal(at(MILESTONE_RING_MS).head?.to, 100, "and the whole of it at the end");
    assert.ok(at(MILESTONE_RING_MS / 10).head!.to < 10, "slow out of the start");
    assert.ok(at((MILESTONE_RING_MS * 9) / 10).head!.to > 90, "and slow into the finish");
    let before = 0;
    for (let ms = 1; ms <= MILESTONE_RING_MS; ms += 1) {
      const head = at(ms).head!.to;
      assert.ok(head >= before, `the head never goes backwards (${ms}ms)`);
      before = head;
    }
  });

  it("draws the head as a short stroke ending where it is, never behind the start", () => {
    const early = at(1).head!;
    assert.equal(early.from, 0);
    const mid = at(MILESTONE_RING_MS / 2).head!;
    assert.ok(mid.from < mid.to && mid.to - mid.from <= 5, "a fixed share, a few percent of the lap");
  });

  it("trails the head with 28 segments over 80% of the lap, end to end", () => {
    const { head, trail } = at(MILESTONE_RING_MS);
    assert.equal(trail.length, 28);
    assert.equal(trail[0]!.to, head!.to, "the trail starts at the head");
    assert.ok(Math.abs(trail[trail.length - 1]!.from - (head!.to - 80)) < 1e-9, "and runs 80% back");
    trail.slice(1).forEach((segment, i) => {
      assert.ok(Math.abs(segment.to - trail[i]!.from) < 1e-9, `segment ${i + 1} meets the one before it`);
    });
  });

  it("never draws the trail behind where the lap started", () => {
    for (let ms = 1; ms < MILESTONE_RING_MS; ms += 10) {
      const { head, trail } = at(ms);
      assert.ok(trail.every((segment) => segment.from >= 0 && segment.from < segment.to), `${ms}ms`);
      assert.ok(trail.length <= 28);
      if (head!.to < 80) assert.equal(trail[trail.length - 1]!.from, 0, `cut at the start, ${ms}ms`);
    }
  });

  it("falls off linearly to nothing along the trail", () => {
    const { trail } = at(MILESTONE_RING_MS);
    trail.slice(1).forEach((segment, i) => {
      assert.ok(segment.opacity < trail[i]!.opacity, `segment ${i + 1} is fainter than the one before`);
    });
    assert.ok(trail[0]!.opacity > 0.95, "nearly whole at the head");
    assert.ok(trail[trail.length - 1]!.opacity < 0.05, "nearly gone at the tail");
    const steps = trail.slice(1).map((segment, i) => trail[i]!.opacity - segment.opacity);
    assert.ok(steps.every((step) => Math.abs(step - steps[0]!) < 1e-9), "by the same step each time");
  });

  it("is white for the first seventh of the trail, cooling to milestone blue", () => {
    const { trail } = at(MILESTONE_RING_MS);
    assert.ok(trail[0]!.white > 0.85, "white-hot at the head");
    trail.slice(1).forEach((segment, i) => {
      assert.ok(segment.white <= trail[i]!.white, `segment ${i + 1} is no whiter than the one before`);
    });
    trail.forEach((segment, i) => {
      if (i >= 28 / 7) assert.equal(segment.white, 0, `segment ${i} is blue`);
      else assert.ok(segment.white > 0, `segment ${i} is still cooling`);
    });
  });

  it("stays whole through the lap, then fades out over the fade and is gone", () => {
    assert.equal(at(0).opacity, 1);
    assert.equal(at(MILESTONE_RING_MS).opacity, 1);
    assert.equal(at(MILESTONE_RING_MS + MILESTONE_RING_FADE_MS / 2).opacity, 0.5);
    assert.equal(at(MILESTONE_RING_MS + MILESTONE_RING_FADE_MS / 2).head?.to, 100, "fading where it ended");
    assert.equal(ringFrame(MILESTONE_RING_MS + MILESTONE_RING_FADE_MS), null);
    assert.equal(ringFrame(MILESTONE_COUNT_MS), null);
    assert.equal(ringFrame(Infinity), null, "nothing on a seat that is not counting");
  });
});
