import type { Achievement } from './types.ts';

const threshold = (
  id: string,
  name: string,
  description: string,
  icon: string,
  goal: number,
  pick: (ctx: Parameters<Achievement['evaluate']>[0]) => number,
  tier?: Achievement['tier'],
): Achievement => ({
  id,
  name,
  description,
  icon,
  tier,
  goal,
  evaluate: (ctx) => {
    const progress = pick(ctx);
    return { unlocked: progress >= goal, progress, goal };
  },
});

/**
 * Coordinate geometry for the achievements below.
 *
 * `coords` is normalised by the board radius (170 mm) with the origin at the
 * bull, so a distance in those units scales straight back to millimetres.
 */
const BOARD_RADIUS_MM = 170;

/** Diameter of the circle three darts must fit inside for Tight Grouping. */
const GROUPING_MM = 20;

/**
 * How close two darts must land to count as one in the other's shaft. A dart
 * shaft is roughly 5 mm across, so centres within that are physically touching.
 */
const SHAFT_MM = 5;

type Point = { x: number; y: number };

const distMm = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y) * BOARD_RADIUS_MM;

/** The darts of a turn the board actually located. */
const locatedPoints = (throws: Array<{ coords: Point | null }>): Point[] =>
  throws.map((t) => t.coords).filter((c): c is Point => c != null);

/**
 * Radius of the smallest circle containing every point, in millimetres.
 *
 * For two or three points the answer is either the circle on the longest pair
 * as its diameter, or -- when no such circle covers the rest -- the circumcircle.
 */
function enclosingRadiusMm(points: Point[]): number {
  if (points.length < 2) return 0;

  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!;
      const b = points[j]!;
      const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const r = distMm(a, b) / 2;
      if (points.every((p) => distMm(p, centre) <= r + 1e-9)) best = Math.min(best, r);
    }
  }
  if (best < Infinity) return best;

  // Three points with none of the pair circles covering the third: the smallest
  // enclosing circle is their circumcircle.
  const [a, b, c] = points as [Point, Point, Point];
  const ab = distMm(a, b);
  const bc = distMm(b, c);
  const ca = distMm(c, a);
  const area =
    Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2 * BOARD_RADIUS_MM ** 2;
  if (area === 0) return Math.max(ab, bc, ca) / 2;   // collinear
  return (ab * bc * ca) / (4 * area);
}

/**
 * The achievement catalogue.
 *
 * Adding one is a single entry here. Because evaluation runs over the stored
 * command log, a new entry backfills across every match ever played rather than
 * starting from zero on the day it is added.
 */
export const CATALOGUE: Achievement[] = [
  // --- X01 event-triggered -------------------------------------------------
  threshold('maximum', 'Maximum', 'Throw a 180.', '\u{1F3AF}', 1, (c) => c.career.count180, 'bronze'),
  threshold('ton-80-club', 'Ton-80 Club', 'Throw 10 maximums.', '\u{1F3AF}', 10, (c) => c.career.count180, 'silver'),
  threshold('maximum-machine', 'Maximum Machine', 'Throw 100 maximums.', '\u{1F3AF}', 100, (c) => c.career.count180, 'gold'),

  {
    id: 'big-fish',
    name: 'Big Fish',
    description: 'Check out from 170, the highest possible finish.',
    icon: '\u{1F41F}',
    tier: 'gold',
    evaluate: ({ playerId, match }) => ({
      unlocked: match.checkouts.some((c) => c.playerId === playerId && c.from === 170),
    }),
  },
  {
    id: 'bullseye-finish',
    name: 'Bullseye Finish',
    description: 'Win a leg on the inner bull.',
    icon: '\u{1F3AF}',
    tier: 'silver',
    evaluate: ({ playerId, match }) => ({
      unlocked: match.checkouts.some((c) => c.playerId === playerId && c.finisher === 'BULL'),
    }),
  },
  {
    id: 'nine-darter',
    name: 'Nine Darter',
    description: 'Win a 501 leg in nine darts.',
    icon: '\u{1F947}',
    tier: 'gold',
    evaluate: ({ playerId, match }) => ({
      unlocked: match.checkouts.some(
        (c) => c.playerId === playerId && c.startScore === 501 && c.darts <= 9,
      ),
    }),
  },
  {
    id: 'shanghai',
    name: 'Shanghai',
    description: 'Hit a single, double and triple of the same number in one turn.',
    icon: '\u{1F3EF}',
    tier: 'gold',
    evaluate: ({ playerId, match }) => {
      const unlocked = match.turns.some((t) => {
        if (t.playerId !== playerId || t.throws.length < 3) return false;
        const numbers = new Set(t.throws.map((x) => x.number));
        if (numbers.size !== 1) return false;
        const rings = new Set(t.throws.map((x) => (x.ring.startsWith('SINGLE') ? 'SINGLE' : x.ring)));
        return rings.has('SINGLE') && rings.has('DOUBLE') && rings.has('TRIPLE');
      });
      return { unlocked };
    },
  },
  {
    id: 'sharpshooter',
    name: 'Sharpshooter',
    description: 'Average over 60 per three darts across a whole match.',
    icon: '\u{1F52D}',
    tier: 'silver',
    goal: 60,
    evaluate: ({ playerId, match }) => {
      if (match.gameType !== 'x01') return { unlocked: false };
      const mine = match.throws.filter((t) => t.playerId === playerId);
      if (mine.length < 9) return { unlocked: false };
      const avg = (mine.reduce((s, t) => s + t.counted, 0) / mine.length) * 3;
      return { unlocked: avg > 60, progress: Math.round(avg), goal: 60 };
    },
  },
  {
    id: 'escape-artist',
    name: 'Escape Artist',
    description: 'Check out after busting earlier in the same leg.',
    icon: '\u{1F9E8}',
    tier: 'silver',
    evaluate: ({ playerId, match }) => {
      const bustedLegs = new Set(
        match.turns.filter((t) => t.playerId === playerId && t.busted).map((t) => t.leg),
      );
      return {
        unlocked: match.checkouts.some(
          (c) => c.playerId === playerId && bustedLegs.size > 0,
        ),
      };
    },
  },

  {
    id: 'perfect-start',
    name: 'Perfect Start',
    description: 'Open a leg with a maximum.',
    icon: '\u{1F680}',
    tier: 'silver',
    evaluate: ({ playerId, match }) => {
      // The player's first turn of any leg scoring 180.
      const firstTurns = new Map<number, boolean>();
      for (const t of match.turns) {
        if (t.playerId !== playerId) continue;
        if (!firstTurns.has(t.leg)) firstTurns.set(t.leg, t.total === 180);
      }
      return { unlocked: [...firstTurns.values()].some(Boolean) };
    },
  },

  // --- Cricket -------------------------------------------------------------
  {
    id: 'cutthroat-assassin',
    name: 'Cut-Throat Assassin',
    description: 'Put 25 or more points onto opponents in a single turn.',
    icon: '\u{1F5E1}',
    tier: 'silver',
    evaluate: ({ playerId, match }) => {
      // Points land on opponents, so look at what everyone else received while
      // this player was throwing -- recorded per turn during analysis.
      const others = Object.entries(match.cutthroatTurnPoints)
        .filter(([pid]) => pid !== playerId)
        .flatMap(([, turns]) => turns);
      return { unlocked: others.some((p) => p >= 25) };
    },
  },
  threshold('mark-machine', 'Mark Machine', 'Earn 500 cricket marks.', '\u{2716}', 500, (c) => c.career.cricketMarks, 'silver'),

  // --- Gotcha --------------------------------------------------------------
  threshold('gotcha', 'Gotcha!', 'Knock an opponent back for the first time.', '\u{1F4A5}', 1, (c) => c.career.knockbacksDealt, 'bronze'),
  threshold('bully', 'Bully', 'Knock opponents back 10 times.', '\u{1F4A5}', 10, (c) => c.career.knockbacksDealt, 'silver'),
  threshold('punching-bag', 'Punching Bag', 'Get knocked back 10 times.', '\u{1F915}', 10, (c) => c.career.knockbacksReceived, 'bronze'),

  // --- Cross-game ----------------------------------------------------------
  threshold('first-blood', 'First Blood', 'Win your first match.', '\u{1F3C6}', 1, (c) => c.career.matchesWon, 'bronze'),
  threshold('century-club', 'Century Club', 'Play 100 legs.', '\u{1F4AF}', 100, (c) => c.career.legsPlayed, 'silver'),
  threshold('on-a-roll', 'On a Roll', 'Win five matches in a row.', '\u{1F525}', 5, (c) => c.career.longestStreak, 'silver'),
  {
    id: 'nemesis',
    name: 'Nemesis',
    description: 'Beat the same opponent 10 times.',
    icon: '\u{1F608}',
    tier: 'gold',
    goal: 10,
    evaluate: ({ career }) => {
      const best = Math.max(0, ...Object.values(career.headToHead).map((h) => h.won));
      return { unlocked: best >= 10, progress: best, goal: 10 };
    },
  },

  // --- Coordinate-based ----------------------------------------------------
  // These read `coords`, which is nullable by design: a turn the board did not
  // localise simply cannot unlock them, and never blocks anything else.
  {
    id: 'tight-grouping',
    name: 'Tight Grouping',
    description: 'Land three darts within a 20 mm circle.',
    icon: '\u{1F3AF}',
    tier: 'gold',
    evaluate: ({ playerId, match }) => ({
      unlocked: match.turns.some((t) => {
        if (t.playerId !== playerId) return false;
        if (t.throws.length !== 3) return false;
        const points = locatedPoints(t.throws);
        if (points.length !== 3) return false;         // one dart unlocated: no claim
        return enclosingRadiusMm(points) * 2 <= GROUPING_MM;
      }),
    }),
  },
  {
    id: 'robin-hood',
    name: 'Robin Hood',
    description: 'Land a dart in the shaft of another.',
    icon: '\u{1F3F9}',
    tier: 'gold',
    evaluate: ({ playerId, match }) => ({
      // Only within one turn: darts from earlier turns are already out of the
      // board, so there is nothing left to hit.
      unlocked: match.turns.some((t) => {
        if (t.playerId !== playerId) return false;
        const points = locatedPoints(t.throws);
        return points.some((a, i) => points.slice(i + 1).some((b) => distMm(a, b) <= SHAFT_MM));
      }),
    }),
  },
];

export const CATALOGUE_BY_ID = new Map(CATALOGUE.map((a) => [a.id, a]));
