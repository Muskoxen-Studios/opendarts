import { Match, type GolfHoleResult } from '@darts/engine';
import type { Coords, DomainEvent, GameConfig, GameType, MatchCommand, Player } from '@darts/schema';

/** A persisted match, exactly as stored: config plus its command log. */
export interface MatchRecord {
  matchId: string;
  gameType: GameType;
  config: GameConfig;
  players: Player[];
  commands: MatchCommand[];
  endedAt: string | null;
  startedAt?: string | null;
}

export interface ThrowRecord {
  playerId: string;
  label: string;
  value: number;
  /** Points actually credited (0 when not yet "in", or when the turn busted). */
  counted: number;
  ring: string;
  number: number;
  /** The player's displayed score before this dart. */
  scoreBefore: number;
  /** True when the player could have checked out from scoreBefore (X01 only). */
  hadCheckout: boolean;
  leg: number;
  /**
   * Where the dart landed, when the source reported it.
   *
   * Null for board throws until the payload's units and origin are settled, and
   * null for every historical throw. Nothing here may depend on it: the heatmap
   * falls back to counting segments, which needs no coordinates at all.
   */
  coords: Coords | null;
}

export interface TurnRecord {
  playerId: string;
  total: number;
  darts: number;
  busted: boolean;
  throws: ThrowRecord[];
  leg: number;
}

export interface CheckoutRecord {
  playerId: string;
  startScore: number;
  darts: number;
  /** The finishing dart, e.g. "D20" or "BULL". */
  finisher: string;
  /** Score the player checked out from at the start of the finishing turn. */
  from: number;
}

export interface KnockbackRecord {
  byPlayerId: string;
  victimPlayerId: string;
  from: number;
  to: number;
}

/** Final Stableford standing of a golf round, per player. */
export interface GolfAnalysis {
  /** The handicap each player actually played off in this round. */
  handicaps: Record<string, number>;
  points: Record<string, number>;
  holes: Record<string, GolfHoleResult[]>;
  /** Holes the round was set up over: 18 normally, 9 for a short round. */
  holeCount: number;
  /** The most holes any player actually completed. */
  holesPlayed: number;
}

export interface MatchAnalysis {
  matchId: string;
  gameType: GameType;
  players: Player[];
  winnerId: string | null;
  endedAt: string | null;
  startedAt: string | null;
  throws: ThrowRecord[];
  turns: TurnRecord[];
  checkouts: CheckoutRecord[];
  knockbacks: KnockbackRecord[];
  legsWon: Record<string, number>;
  legsPlayed: number;
  /** Cricket marks earned per player across the match. */
  cricketMarks: Record<string, number>;
  /** Cricket points scored onto opponents in a single turn, per player. */
  cutthroatTurnPoints: Record<string, number[]>;
  /** Golf only; null for every other game. */
  golf: GolfAnalysis | null;
  /** True when the match was stopped early and awarded to whoever led. */
  conceded: boolean;
}

/**
 * Replay a stored match through the engine to derive everything statistics and
 * achievements need.
 *
 * This is deliberately engine-agnostic: it steps the command log one command at
 * a time and reads the resulting views and domain events, so a newly added game
 * is analysable without touching this file.
 */
export function analyzeMatch(record: MatchRecord): MatchAnalysis {
  const match = new Match(record.matchId, record.players, record.config);

  const analysis: MatchAnalysis = {
    matchId: record.matchId,
    gameType: record.gameType,
    players: record.players,
    winnerId: null,
    endedAt: record.endedAt,
    startedAt: record.startedAt ?? null,
    throws: [],
    turns: [],
    checkouts: [],
    knockbacks: [],
    legsWon: Object.fromEntries(record.players.map((p) => [p.id, 0])),
    legsPlayed: 0,
    cricketMarks: Object.fromEntries(record.players.map((p) => [p.id, 0])),
    cutthroatTurnPoints: Object.fromEntries(record.players.map((p) => [p.id, []])),
    golf: null,
    conceded: false,
  };

  let pending: ThrowRecord[] = [];
  let turnCricketPoints: Record<string, number> = {};

  for (const cmd of record.commands) {
    const before = match.view;
    const events: DomainEvent[] = match.apply(cmd);

    if (cmd.type === 'THROW') {
      const activeId = before.activePlayerId;
      const activeView = before.players.find((p) => p.playerId === activeId);
      const recorded = events.find((e) => e.type === 'throw.recorded');
      const rec: ThrowRecord = {
        playerId: activeId ?? '',
        label: labelOf(cmd),
        value: cmd.throw.value,
        counted: recorded && recorded.type === 'throw.recorded' ? recorded.value : 0,
        ring: cmd.throw.segment.ring,
        number: cmd.throw.segment.number,
        scoreBefore: activeView?.score ?? 0,
        hadCheckout: (activeView?.checkout?.length ?? 0) > 0,
        leg: before.leg,
        coords: cmd.throw.coords ?? null,
      };
      analysis.throws.push(rec);
      pending.push(rec);
    }

    for (const e of events) {
      switch (e.type) {
        case 'turn.completed': {
          analysis.turns.push({
            playerId: e.playerId,
            total: e.total,
            darts: e.darts,
            busted: e.busted,
            throws: pending,
            leg: before.leg,
          });
          for (const [pid, pts] of Object.entries(turnCricketPoints)) {
            if (pts > 0) analysis.cutthroatTurnPoints[pid]?.push(pts);
          }
          pending = [];
          turnCricketPoints = {};
          break;
        }
        case 'leg.won': {
          analysis.legsWon[e.playerId] = (analysis.legsWon[e.playerId] ?? 0) + 1;
          analysis.legsPlayed += 1;
          break;
        }
        case 'x01.checkout': {
          const last = analysis.throws.at(-1);
          const turnStart = pending[0]?.scoreBefore ?? last?.scoreBefore ?? 0;
          analysis.checkouts.push({
            playerId: e.playerId,
            startScore: e.score,
            darts: e.darts,
            finisher: last?.label ?? '',
            from: turnStart,
          });
          break;
        }
        case 'cricket.points': {
          turnCricketPoints[e.playerId] = (turnCricketPoints[e.playerId] ?? 0) + e.points;
          break;
        }
        case 'gotcha.knockback': {
          analysis.knockbacks.push({
            byPlayerId: e.byPlayerId,
            victimPlayerId: e.victimPlayerId,
            from: e.from,
            to: e.to,
          });
          break;
        }
        case 'match.won': {
          analysis.winnerId = e.playerId;
          break;
        }
        case 'match.conceded': {
          analysis.conceded = true;
          break;
        }
        default:
          break;
      }
    }
  }

  if (record.gameType === 'golf') {
    // Read off the final view rather than tracking holes here: the engine
    // already publishes each player's card, and duplicating that logic is how
    // the two drift apart.
    const finalView = match.view;
    const golf: GolfAnalysis = {
      handicaps: {},
      points: {},
      holes: {},
      holeCount: 0,
      holesPlayed: 0,
    };
    for (const p of finalView.players) {
      const holes = (p.detail.results as GolfHoleResult[] | undefined) ?? [];
      golf.handicaps[p.playerId] = Number(p.detail.handicap ?? 0);
      golf.points[p.playerId] = p.score;
      golf.holes[p.playerId] = holes;
      golf.holeCount = Math.max(golf.holeCount, Number(p.detail.holes ?? 0));
      golf.holesPlayed = Math.max(golf.holesPlayed, holes.length);
    }
    analysis.golf = golf;
  }

  if (record.gameType === 'cricket') {
    for (const t of analysis.throws) {
      const marks = t.ring === 'TRIPLE' ? 3 : t.ring === 'DOUBLE' || t.ring === 'BULL' ? 2 : t.ring === 'MISS' ? 0 : 1;
      const isTarget = [15, 16, 17, 18, 19, 20, 25].includes(t.number);
      if (isTarget) {
        analysis.cricketMarks[t.playerId] = (analysis.cricketMarks[t.playerId] ?? 0) + marks;
      }
    }
  }

  return analysis;
}

function labelOf(cmd: Extract<MatchCommand, { type: 'THROW' }>): string {
  const s = cmd.throw.segment;
  if (s.ring === 'MISS') return 'MISS';
  if (s.ring === 'BULL') return 'BULL';
  if (s.ring === 'OUTER_BULL') return '25';
  if (s.ring === 'DOUBLE') return `D${s.number}`;
  if (s.ring === 'TRIPLE') return `T${s.number}`;
  return `S${s.number}`;
}
