import type { Coords, GameType } from '@darts/schema';
import type { GolfHoleResult } from '@darts/engine';
import type { CheckoutRecord, MatchAnalysis, ThrowRecord } from './analysis.ts';

/**
 * Where darts land, aggregated.
 *
 * Two representations, because coordinates are not guaranteed. `cells` and
 * `byNumber` are pure segment counts and always work -- they need nothing more
 * than what scoring already records. `dots` are only populated for throws whose
 * source reported coordinates, and the UI overlays them when there are any.
 */
export interface HeatCell {
  number: number;
  ring: string;
  count: number;
}

export interface HeatDot {
  x: number;
  y: number;
  playerId: string;
}

export interface Heatmap {
  total: number;
  cells: HeatCell[];
  /** Highest single-cell count, so a renderer can normalise. */
  max: number;
  /** Total hits per board number; 0 collects misses. */
  byNumber: Record<number, number>;
  maxByNumber: number;
  dots: HeatDot[];
  /** How many of the throws carried coordinates. */
  withCoords: number;
}

export interface HeatInput {
  playerId: string;
  number: number;
  ring: string;
  coords?: Coords | null;
}

export function buildHeatmap(throws: readonly HeatInput[]): Heatmap {
  const cells = new Map<string, HeatCell>();
  const byNumber: Record<number, number> = {};
  const dots: HeatDot[] = [];
  let withCoords = 0;

  for (const t of throws) {
    const key = `${t.number}:${t.ring}`;
    const cell = cells.get(key) ?? { number: t.number, ring: t.ring, count: 0 };
    cell.count += 1;
    cells.set(key, cell);

    byNumber[t.number] = (byNumber[t.number] ?? 0) + 1;

    if (t.coords) {
      withCoords += 1;
      dots.push({ x: t.coords.x, y: t.coords.y, playerId: t.playerId });
    }
  }

  const list = [...cells.values()].sort((a, b) => b.count - a.count);
  return {
    total: throws.length,
    cells: list,
    max: list[0]?.count ?? 0,
    byNumber,
    maxByNumber: Math.max(0, ...Object.values(byNumber)),
    dots,
    withCoords,
  };
}

export interface PlayerSummary {
  playerId: string;
  name: string;
  color: string;
  darts: number;
  /**
   * The headline number for the match: points scored for X01, marks for
   * cricket, Stableford points for golf.
   */
  score: number;
  legsWon: number;
  average3: number | null;
  first9Average: number | null;
  bestTurn: number | null;
  count180: number;
  count140plus: number;
  count100plus: number;
  bustedTurns: number;
  checkouts: CheckoutRecord[];
  highestCheckout: number;
  mpr: number | null;
  golf: {
    handicap: number;
    points: number;
    holes: GolfHoleResult[];
    holed: number;
    birdiesOrBetter: number;
  } | null;
  heatmap: Heatmap;
}

/** The turn that ended the match, offered to the UI so it can be replayed. */
export interface WinningTurn {
  playerId: string;
  name: string;
  color: string;
  darts: Array<{ label: string; value: number; counted: number; coords: Coords | null }>;
}

export interface MatchReport {
  matchId: string;
  gameType: GameType;
  winnerId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  /** True when the match was ended early rather than actually won. */
  conceded: boolean;
  legsPlayed: number;
  totalDarts: number;
  players: PlayerSummary[];
  heatmap: Heatmap;
  winningTurn: WinningTurn | null;
}

function averageOfTurns(turns: Array<{ total: number; darts: number; busted: boolean }>): number | null {
  let points = 0;
  let darts = 0;
  for (const t of turns) {
    points += t.busted ? 0 : t.total;
    darts += t.darts;
  }
  return darts > 0 ? (points / darts) * 3 : null;
}

/**
 * Everything the post-match screen shows, derived from the analysis alone.
 *
 * Kept out of the server so it can be unit-tested against a command log and
 * reused for the "last game" view without a second code path.
 */
export function summarizeMatch(a: MatchAnalysis): MatchReport {
  const players: PlayerSummary[] = a.players.map((p) => {
    const mine = a.throws.filter((t) => t.playerId === p.id);
    const turns = a.turns.filter((t) => t.playerId === p.id);
    const scored = turns.filter((t) => !t.busted);
    const checkouts = a.checkouts.filter((c) => c.playerId === p.id);

    // First nine: the opening three turns of each leg, as in career stats.
    const byLeg = new Map<number, typeof turns>();
    for (const t of turns) {
      const list = byLeg.get(t.leg) ?? [];
      list.push(t);
      byLeg.set(t.leg, list);
    }
    const first9 = [...byLeg.values()].flatMap((list) => list.slice(0, 3));

    const holes = a.golf?.holes[p.id] ?? [];

    return {
      playerId: p.id,
      name: p.name,
      color: p.color,
      darts: mine.length,
      score: scoreOf(a, p.id),
      legsWon: a.legsWon[p.id] ?? 0,
      average3: a.gameType === 'x01' ? averageOfTurns(turns) : null,
      first9Average: a.gameType === 'x01' ? averageOfTurns(first9) : null,
      bestTurn: scored.length > 0 ? Math.max(...scored.map((t) => t.total)) : null,
      count180: scored.filter((t) => t.total === 180).length,
      count140plus: scored.filter((t) => t.total >= 140).length,
      count100plus: scored.filter((t) => t.total >= 100).length,
      bustedTurns: turns.filter((t) => t.busted).length,
      checkouts,
      highestCheckout: checkouts.reduce((max, c) => Math.max(max, c.from), 0),
      mpr:
        a.gameType === 'cricket' && mine.length >= 3
          ? (a.cricketMarks[p.id] ?? 0) / Math.floor(mine.length / 3)
          : null,
      golf: a.golf
        ? {
            handicap: a.golf.handicaps[p.id] ?? 0,
            points: a.golf.points[p.id] ?? 0,
            holes,
            holed: holes.filter((h) => h.holed).length,
            birdiesOrBetter: holes.filter((h) => h.holed && h.strokes < h.par).length,
          }
        : null,
      heatmap: buildHeatmap(mine),
    };
  });

  return {
    matchId: a.matchId,
    gameType: a.gameType,
    winnerId: a.winnerId,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    durationMs: durationOf(a),
    conceded: a.conceded,
    legsPlayed: a.legsPlayed,
    totalDarts: a.throws.length,
    players,
    heatmap: buildHeatmap(a.throws),
    winningTurn: winningTurnOf(a),
  };
}

function durationOf(a: MatchAnalysis): number | null {
  if (!a.startedAt || !a.endedAt) return null;
  const ms = Date.parse(a.endedAt) - Date.parse(a.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * The last score the winner posted.
 *
 * For X01 that is the checkout; for the other games it is whatever turn tipped
 * the match over. Null when nobody won -- an abandoned match has no last hurrah.
 */
function winningTurnOf(a: MatchAnalysis): WinningTurn | null {
  if (!a.winnerId) return null;
  const player = a.players.find((p) => p.id === a.winnerId);
  if (!player) return null;
  const turn = [...a.turns].reverse().find((t) => t.playerId === a.winnerId && t.throws.length > 0);
  if (!turn) return null;
  return {
    playerId: player.id,
    name: player.name,
    color: player.color,
    darts: turn.throws.map((t: ThrowRecord) => ({
      label: t.label,
      value: t.value,
      counted: t.counted,
      coords: t.coords,
    })),
  };
}

/**
 * The player's standing at the end, in the units the game displays.
 *
 * Derived from the throws rather than the engine's final view, because the view
 * has already been reset for the next leg by the time the match ends.
 */
function scoreOf(a: MatchAnalysis, playerId: string): number {
  if (a.gameType === 'golf') return a.golf?.points[playerId] ?? 0;
  if (a.gameType === 'cricket') return a.cricketMarks[playerId] ?? 0;
  const turns = a.turns.filter((t) => t.playerId === playerId && !t.busted);
  return turns.reduce((sum, t) => sum + t.total, 0);
}
