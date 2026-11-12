import { beforeEach, describe, expect, it } from 'vitest';
import { MinefieldConfigSchema } from '@darts/schema';
import { Match } from './match.ts';
import { play, players, resetDartIds, scoreOf, seg, throwCmd } from './testkit.ts';

function newMatch(overrides: Record<string, unknown> = {}, names = ['Alice', 'Bob']): Match {
  const m = new Match('minefield-test', players(...names), {
    gameType: 'minefield', targetScore: 10000, hitPoints: 6, ...overrides,
  });
  m.apply({ type: 'START' });
  return m;
}

function field(m: Match, number: number) {
  const cells = m.view.players[0]!.detail.field as {
    number: number; hp: number; multiplier: number; nextMultiplier: number | null;
    hazard: 'mine' | 'blast' | null; hitsRemaining: number; resetsScore: boolean; penalty: number | null;
  }[];
  return cells.find((cell) => cell.number === number)!;
}

function arm(m: Match, number: number): void {
  play(m, ...Array.from({ length: field(m, number).hp }, () => String(number)));
}

beforeEach(resetDartIds);

describe('Minefield', () => {
  it('defaults to configurable per-player HP and rejects non-count values', () => {
    expect(MinefieldConfigSchema.parse({ gameType: 'minefield' })).toMatchObject({
      hitPoints: null, hitPointsPerPlayer: 2, mode: 'normal', mineLifetime: 1, defusal: true,
      blastRadius: false, targetScore: 301, legsToWin: 1, setsToWin: 1, roundLimit: null,
    });
    for (const hitPoints of [-1, 1.5, 6.5]) {
      expect(() => newMatch({ hitPoints })).toThrow();
    }
    expect(() => newMatch({ targetScore: 0 })).toThrow();
    for (const hitPoints of [1, 3, 5]) {
      expect(newMatch({ hitPoints }).config).toMatchObject({ hitPoints });
      expect(field(newMatch({ hitPoints }), 20).hp).toBe(hitPoints);
    }
  });

  it('scales HP with a configurable per-player value without a floor or cap', () => {
    for (const [names, expected] of [
      [['Alice'], 2], [['Alice', 'Bob'], 4], [['Alice', 'Bob', 'Cara'], 6],
      [['Alice', 'Bob', 'Cara', 'Dan'], 8],
    ] as const) {
      const m = newMatch({ hitPoints: null }, [...names]);
      expect(m.view.players[0]!.detail.hitPoints).toBe(expected);
      expect(field(m, 20).hp).toBe(expected);
      expect(field(m, 25).hp).toBe(expected);
    }
    expect(field(newMatch({ hitPoints: 8 }, ['Alice', 'Bob', 'Cara']), 20).hp).toBe(8);
  });

  it('removes one HP per safe dart regardless of ring and scores the arming dart', () => {
    const m = newMatch();
    play(m, 'T20', 'D20', '20');
    expect(scoreOf(m, 'alice')).toBe(120);
    expect(field(m, 20).hp).toBe(3);
    m.apply(throwCmd('T20'));
    m.apply(throwCmd('D20'));
    m.apply(throwCmd('20'));
    expect(scoreOf(m, 'bob')).toBe(120);
    expect(field(m, 20)).toMatchObject({ number: 20, hp: 0, multiplier: 1, nextMultiplier: 1 });
    expect(m.view.awaitingTakeout).toBe(true);
    expect(m.view.activePlayerId).toBe('bob');
    expect(m.apply(throwCmd('1'))).toEqual([]);
    expect(field(m, 1).hp).toBe(6);
  });

  it('explodes on the very next hit, resets immediately, and lets later darts score', () => {
    const m = newMatch();
    arm(m, 20);
    const events = m.apply(throwCmd('20'));
    expect(events).toContainEqual({ type: 'throw.recorded', playerId: 'alice', dartIndex: 0, value: -20 });
    expect(m.view.turn.throws[0]!.value).toBe(-20);
    expect(field(m, 20)).toMatchObject({ number: 20, hp: 6, multiplier: 1.5, nextMultiplier: null });
    expect(field(m, 19)).toMatchObject({ hp: 6, multiplier: 1 });
    m.apply(throwCmd('20'));
    m.apply(throwCmd('20'));
    expect(m.view.turn.throws.map((t) => t.value)).toEqual([-20, 20, 20]);
    expect(m.view.turn.total).toBe(20);
    expect(field(m, 20).hp).toBe(4);
    expect(m.view.awaitingTakeout).toBe(true);
  });

  it.each([
    { number: 20, label: 'D20', value: 40 },
    { number: 20, label: 'T20', value: 60 },
    { number: 25, label: 'BULL', value: 50 },
  ])('defuses an armed $number with $label, scoring $value without escalating', ({ number, label, value }) => {
    const m = newMatch();
    arm(m, number);
    play(m, String(number)); // explode once, so defusing must also preserve a raised multiplier
    arm(m, number);
    expect(field(m, number).nextMultiplier).toBe(1.5);
    const events = m.apply(throwCmd(label));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'throw.recorded', value })]));
    expect(field(m, number)).toMatchObject({ hp: 6, multiplier: 1.5, nextMultiplier: null });
    m.apply({ type: 'UNDO' });
    expect(field(m, number)).toMatchObject({ hp: 0, multiplier: 1.5 });
  });

  it('refolds a corrected defuse as an explosion', () => {
    const m = newMatch();
    arm(m, 20);
    const command = throwCmd('D20');
    m.apply(command);
    if (command.type !== 'THROW') throw new Error('expected throw');
    expect(field(m, 20)).toMatchObject({ hp: 6, multiplier: 1 });
    m.apply({ type: 'CORRECT_THROW', throwId: command.throw.id, segment: seg('20') });
    expect(field(m, 20)).toMatchObject({ hp: 6, multiplier: 1.5 });
    expect(m.view.turn.throws.at(-1)!.value).toBe(-20);
  });

  it('requires full HP depletion between explosions and raises each new cycle by 0.5x', () => {
    const m = newMatch();
    for (const multiplier of [1, 1.5, 2, 2.5]) {
      arm(m, 20);
      expect(field(m, 20).nextMultiplier).toBe(multiplier);
      const events = m.apply(throwCmd('20'));
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'throw.recorded', value: -20 * multiplier })]));
      expect(field(m, 20)).toMatchObject({ hp: 6, multiplier: multiplier + 0.5, nextMultiplier: null });
      if (m.view.awaitingTakeout) m.apply({ type: 'ADVANCE_TURN' });
    }
  });

  it('rounds each odd-number and bull penalty to whole points, with halves up', () => {
    for (const number of [19, 25]) {
      const m = newMatch();
      arm(m, number);
      play(m, String(number)); // 1x blast, reset to 1.5x
      arm(m, number);
      const events = m.apply(throwCmd(number === 25 ? '25' : '19'));
      const expected = number === 25 ? -38 : -29;
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'throw.recorded', value: expected })]));
      expect(m.view.turn.throws.at(-1)!.value).toBe(expected);
      expect(m.view.players.every((p) => Number.isInteger(p.score))).toBe(true);
      expect(m.allEvents.filter((e) => e.type === 'throw.recorded').every((e) => Number.isInteger(e.value))).toBe(true);
    }
  });

  it('shares both bull rings and leaves HP and multipliers unchanged on misses', () => {
    const m = newMatch();
    play(m, '25', 'BULL', '25', 'BULL', '25', 'BULL');
    expect(scoreOf(m, 'alice')).toBe(100);
    expect(scoreOf(m, 'bob')).toBe(125);
    expect(field(m, 25).hp).toBe(0);
    m.apply(throwCmd('MISS'));
    expect(field(m, 25)).toMatchObject({ hp: 0, multiplier: 1 });
    m.apply(throwCmd('25'));
    expect(m.view.turn.throws.at(-1)!.value).toBe(-25);
    expect(field(m, 25)).toMatchObject({ hp: 6, multiplier: 1.5 });
  });

  it('wins immediately when a safe dart reaches or crosses the target', () => {
    const m = newMatch({ targetScore: 70 });
    m.apply(throwCmd('T20'));
    m.apply(throwCmd('T19'));
    expect(scoreOf(m, 'alice')).toBe(117);
    expect(m.view.winnerId).toBe('alice');
    expect(m.view.status).toBe('finished');
  });

  it('resets scores and the field for a new set and rotates its starter', () => {
    const m = newMatch({ targetScore: 20, legsToWin: 1, setsToWin: 2 });
    m.apply(throwCmd('20'));
    expect(m.view.set).toBe(2);
    expect(m.view.activePlayerId).toBe('bob');
    expect(scoreOf(m, 'alice')).toBe(0);
    expect(field(m, 20)).toMatchObject({ hp: 6, multiplier: 1 });
    m.apply({ type: 'NEXT_PLAYER' });
    m.apply(throwCmd('20'));
    expect(m.view.winnerId).toBe('alice');
  });

  it('honours the round limit after both full and manually ended turns', () => {
    for (const handover of ['NEXT_PLAYER', 'ADVANCE_TURN'] as const) {
      const m = newMatch({ roundLimit: 1 });
      if (handover === 'NEXT_PLAYER') {
        m.apply(throwCmd('20'));
        m.apply({ type: handover });
        m.apply(throwCmd('19'));
      } else {
        play(m, '20', 'MISS', 'MISS');
        for (const label of ['19', 'MISS', 'MISS']) m.apply(throwCmd(label));
        expect(m.view.status).toBe('playing');
      }
      m.apply({ type: handover });
      expect(m.view.status).toBe('finished');
      expect(m.view.winnerId).toBe('alice');
    }
  });

  it('restarts scores, mines, multipliers and round counters', () => {
    const m = newMatch();
    arm(m, 20);
    play(m, '20');
    expect(field(m, 20).multiplier).toBe(1.5);
    expect(m.view.round).toBe(2);
    m.apply({ type: 'RESTART_LEG' });
    expect(m.view.round).toBe(1);
    expect(m.view.activePlayerId).toBe('alice');
    expect(m.view.turn.throws).toEqual([]);
    expect(m.view.players.map((p) => p.score)).toEqual([0, 0]);
    expect(field(m, 20)).toMatchObject({ hp: 6, multiplier: 1 });
  });

  it('replays a corrected arming dart and undo without inventing an explosion', () => {
    const m = newMatch();
    arm(m, 20);
    const armingId = m.view.recent.at(-1)!.id;
    m.apply(throwCmd('20'));
    expect(field(m, 20)).toMatchObject({ hp: 6, multiplier: 1.5 });
    m.apply({ type: 'CORRECT_THROW', throwId: armingId, segment: seg('19') });
    expect(field(m, 20)).toMatchObject({ hp: 0, multiplier: 1 });
    expect(m.view.turn.throws.at(-1)!.value).toBe(20);
    m.apply({ type: 'UNDO' });
    expect(field(m, 20)).toMatchObject({ hp: 1, multiplier: 1 });
    expect(Match.fromLog(m.matchId, m.players, m.config, [...m.log]).view).toEqual(m.view);
  });

  it('undoes an explosion and restores the armed mine with its previous multiplier', () => {
    const m = newMatch();
    arm(m, 20);
    m.apply(throwCmd('20'));
    m.apply({ type: 'UNDO' });
    expect(field(m, 20)).toMatchObject({ hp: 0, multiplier: 1, nextMultiplier: 1 });
    expect(scoreOf(m, 'alice')).toBe(60);
  });

  it('keeps HP stable through roster changes until the next leg', () => {
    const m = newMatch({ hitPoints: null, hitPointsPerPlayer: 3 });
    arm(m, 20);
    m.apply({ type: 'ADD_PLAYER', player: players('Cara')[0]! });
    expect(scoreOf(m, 'cara')).toBe(0);
    m.apply(throwCmd('20'));
    expect(field(m, 20)).toMatchObject({ hp: 6, multiplier: 1.5 });
    m.apply({ type: 'RESTART_LEG' });
    expect(field(m, 20)).toMatchObject({ hp: 9, multiplier: 1 });
    m.apply(throwCmd('20'));
    m.apply({ type: 'REMOVE_PLAYER', playerId: 'bob' });
    expect(m.view.turn.total).toBe(20);
    expect(m.view.turn.throws[0]!.value).toBe(20);
    expect(field(m, 20).hp).toBe(8);
    m.apply({ type: 'RESTART_LEG' });
    expect(field(m, 20).hp).toBe(6);
  });

  it('ends early using the highest score', () => {
    const m = newMatch();
    play(m, '20', 'MISS', 'MISS', '19', 'MISS', 'MISS');
    m.apply({ type: 'END_MATCH' });
    expect(m.view.winnerId).toBe('alice');
  });
});

describe('Minefield options', () => {
  it('allows zero HP, small per-player values and large totals with no arbitrary bounds', () => {
    const zero = newMatch({ hitPoints: 0 });
    expect(field(zero, 20)).toMatchObject({ hp: 0, hazard: 'mine', hitsRemaining: 1 });
    play(zero, '20');
    expect(scoreOf(zero, 'alice')).toBe(-20);
    expect(field(zero, 20)).toMatchObject({ hp: 0, multiplier: 1.5 });
    const defused = zero.apply(throwCmd('D20'));
    expect(defused).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'minefield.defused', rearmed: true })]));
    expect(field(zero, 20)).toMatchObject({ hp: 0, multiplier: 1.5 });
    expect(field(newMatch({ hitPoints: null, hitPointsPerPlayer: 1 }, ['Alice']), 20).hp).toBe(1);
    expect(field(newMatch({ hitPoints: null, hitPointsPerPlayer: 1234 }), 20).hp).toBe(2468);
    expect(field(newMatch({ hitPoints: 999999 }), 20).hp).toBe(999999);
  });

  it('uses the configured lifetime before resetting and escalating once', () => {
    const m = newMatch({ hitPoints: 1, mineLifetime: 3, defusal: false });
    arm(m, 20);
    play(m, '20');
    expect(field(m, 20)).toMatchObject({ hp: 0, hitsRemaining: 2, multiplier: 1 });
    play(m, 'D20');
    expect(field(m, 20)).toMatchObject({ hp: 0, hitsRemaining: 1, multiplier: 1 });
    play(m, 'T20');
    expect(field(m, 20)).toMatchObject({ hp: 1, hazard: null, multiplier: 1.5 });
    expect(m.allEvents.filter((e) => e.type === 'throw.recorded').map((e) => e.value)).toEqual([20, -20, -20, -20]);
  });

  it('defuses the entire remaining lifetime when enabled', () => {
    const m = newMatch({ hitPoints: 1, mineLifetime: 10 });
    arm(m, 20);
    play(m, 'D20');
    expect(field(m, 20)).toMatchObject({ hp: 1, hazard: null, multiplier: 1 });
    expect(scoreOf(m, 'alice')).toBe(60);
  });

  it('validates mine lifetime as a positive whole count without an upper cap', () => {
    for (const mineLifetime of [0, -1, 1.5]) expect(() => newMatch({ mineLifetime })).toThrow();
    expect(newMatch({ mineLifetime: 999999 }).config).toMatchObject({ mineLifetime: 999999 });
  });
});

describe('Minefield blast radius', () => {
  it.each(['1', '20'])('explodes the whole mine on a hit to %s, scoring only the hit field', (hit) => {
    const m = newMatch({ hitPoints: 2, blastRadius: true, defusal: false }, ['Alice']);
    play(m, '5'); // collateral damage must restore even a partially worn field
    arm(m, 20);
    expect(field(m, 1)).toMatchObject({ hazard: 'blast', penalty: 1 });
    expect(field(m, 5)).toMatchObject({ hazard: 'blast', hp: 1, penalty: 5 });
    play(m, hit);
    expect(m.view.turn.throws.at(-1)!.value).toBe(hit === '1' ? -1 : -45);
    for (const n of [1, 20, 5]) {
      expect(field(m, n)).toMatchObject({ hazard: null, hp: 2, multiplier: 1.5 });
    }
    expect(field(m, 18)).toMatchObject({ hazard: null, multiplier: 1 });
    expect(m.allEvents.filter((e) => e.type === 'minefield.exploded')).toHaveLength(1);
  });

  it.each([false, true])('applies the negative-score reset option: %s', (resetNegative) => {
    const m = newMatch({ hitPoints: 1, blastRadius: true, defusal: false, resetNegative });
    arm(m, 20);
    arm(m, 25);
    m.apply({ type: 'NEXT_PLAYER' });
    play(m, '5');
    expect(scoreOf(m, 'bob')).toBe(-5);
    m.apply(throwCmd('25'));
    expect(scoreOf(m, 'bob')).toBe(resetNegative ? 0 : -5);
    expect(field(m, 25)).toMatchObject({ hp: 1, multiplier: 1.5 });
  });

  it('respects the hit hazard lifetime before clearing the whole mine', () => {
    const m = newMatch({ hitPoints: 1, blastRadius: true, mineLifetime: 2, defusal: false });
    arm(m, 20);
    play(m, '1');
    expect(field(m, 1)).toMatchObject({ hazard: 'blast', hitsRemaining: 1 });
    expect(field(m, 20)).toMatchObject({ hazard: 'mine', hitsRemaining: 2 });
    play(m, '1');
    for (const n of [1, 20, 5]) {
      expect(field(m, n)).toMatchObject({ hazard: null, hp: 1, multiplier: 1.5 });
    }
  });

  it('chains into an adjacent mine and its radius, and restores the chain on undo', () => {
    const m = newMatch({ hitPoints: 1, blastRadius: true }, ['Alice']);
    play(m, '20', 'D1', '1'); // defuse the zone, then arm a mine next to 20
    expect(field(m, 1).hazard).toBe('mine');
    const before = m.view;
    play(m, '20');
    expect(scoreOf(m, 'alice')).toBe(0);
    for (const n of [5, 20, 1, 18]) {
      expect(field(m, n)).toMatchObject({ hazard: null, hp: 1, multiplier: 1.5 });
    }
    expect(field(m, 4)).toMatchObject({ hazard: null, multiplier: 1 });
    expect(Match.fromLog(m.matchId, m.players, m.config, [...m.log]).view).toEqual(m.view);
    m.apply({ type: 'UNDO' });
    expect(m.view).toEqual(before);
  });

  it('chains through adjacent mines around the board and rearms zero-HP fields once', () => {
    const m = newMatch({ hitPoints: 0, blastRadius: true, defusal: false });
    play(m, '20');
    for (let n = 1; n <= 20; n++) {
      expect(field(m, n)).toMatchObject({ hazard: 'mine', multiplier: 1.5, hitsRemaining: 1 });
    }
    expect(field(m, 25)).toMatchObject({ hazard: 'mine', multiplier: 1 });
    expect(m.allEvents.filter((e) => e.type === 'minefield.exploded')).toHaveLength(1);
  });

  it('keeps overlapping zones until their last source clears', () => {
    const m = newMatch({ hitPoints: 1, blastRadius: true });
    play(m, '20', '18'); // both cover 1
    expect(field(m, 1).hazard).toBe('blast');
    play(m, 'D20');
    expect(field(m, 5).hazard).toBeNull();
    expect(field(m, 1).hazard).toBe('blast');
    play(m, 'D18');
    expect(field(m, 1).hazard).toBeNull();
    expect(field(m, 4).hazard).toBeNull();
  });

  it('explodes both source mines when their shared blast zone is hit', () => {
    const m = newMatch({ hitPoints: 1, blastRadius: true });
    play(m, '20', '18', '1');
    expect(field(m, 1).hazard).toBeNull();
    for (const n of [5, 20, 1, 18, 4]) {
      expect(field(m, n)).toMatchObject({ hazard: null, hp: 1, multiplier: 1.5 });
    }
  });

  it('treats blast-zone doubles as defusals only when the option is enabled', () => {
    for (const defusal of [false, true]) {
      const m = newMatch({ hitPoints: 1, blastRadius: true, defusal });
      arm(m, 20);
      m.apply(throwCmd('D1'));
      expect(m.view.turn.throws.at(-1)!.value).toBe(defusal ? 2 : -1);
      expect(field(m, 1)).toMatchObject({ hazard: null, multiplier: defusal ? 1 : 1.5 });
      expect(field(m, 20).hazard).toBe(defusal ? 'mine' : null);
    }
  });

  it('never gives bull neighbours and prioritises direct mines over zones', () => {
    const bull = newMatch({ hitPoints: 1, blastRadius: true, defusal: false });
    arm(bull, 25);
    expect(bull.view.players[0]!.detail.field).toEqual(expect.arrayContaining([expect.objectContaining({ number: 25, hazard: 'mine' })]));
    for (let n = 1; n <= 20; n++) expect(field(bull, n).hazard).toBeNull();
    play(bull, '25');
    expect(scoreOf(bull, 'alice')).toBe(0);
    const allMines = newMatch({ hitPoints: 0, blastRadius: true, defusal: false });
    expect(field(allMines, 1)).toMatchObject({ hazard: 'mine', resetsScore: true, hitsRemaining: 1 });
  });

  it('replays corrections, undo and restart across zone lifetimes', () => {
    const m = newMatch({ hitPoints: 1, blastRadius: true, mineLifetime: 2, mode: 'gotcha' });
    arm(m, 20);
    m.apply(throwCmd('1'));
    const id = m.view.recent.at(-1)!.id;
    expect(field(m, 1).hitsRemaining).toBe(1);
    m.apply({ type: 'CORRECT_THROW', throwId: id, segment: seg('5') });
    expect(field(m, 1).hitsRemaining).toBe(2);
    expect(field(m, 5).hitsRemaining).toBe(1);
    m.apply({ type: 'UNDO' });
    expect(field(m, 5).hitsRemaining).toBe(2);
    expect(Match.fromLog(m.matchId, m.players, m.config, [...m.log]).view).toEqual(m.view);
    m.apply({ type: 'RESTART_LEG' });
    expect(field(m, 20)).toMatchObject({ hp: 1, hazard: null, multiplier: 1 });
    expect(field(m, 1).hazard).toBeNull();
  });
});

describe('Minefield Gotcha', () => {
  it('knocks opponents back on matching their positive total only in Gotcha mode', () => {
    for (const mode of ['normal', 'gotcha']) {
      const m = newMatch({ mode, hitPoints: 100 });
      play(m, '20');
      m.apply({ type: 'NEXT_PLAYER' });
      const events = m.apply(throwCmd('D10'));
      expect(scoreOf(m, 'alice')).toBe(mode === 'gotcha' ? 0 : 20);
      if (mode === 'gotcha') expect(events).toContainEqual({ type: 'gotcha.knockback', byPlayerId: 'bob', victimPlayerId: 'alice', from: 20, to: 0 });
    }
  });

  it('supports previous-turn knockback', () => {
    const m = newMatch({ mode: 'gotcha', hitPoints: 100, knockback: 'previousTurn' });
    play(m, '10'); m.apply({ type: 'NEXT_PLAYER' });
    play(m, '7'); m.apply({ type: 'NEXT_PLAYER' });
    play(m, '5'); m.apply({ type: 'NEXT_PLAYER' });
    play(m, '8');
    expect(scoreOf(m, 'alice')).toBe(10);
    expect(scoreOf(m, 'bob')).toBe(15);
  });

  it('busts an exact-finish overshoot but retains physical HP damage', () => {
    const m = newMatch({ mode: 'gotcha', targetScore: 30, hitPoints: 100 });
    play(m, '20');
    const events = m.apply(throwCmd('D6'));
    expect(scoreOf(m, 'alice')).toBe(0);
    expect(m.view.turn.total).toBe(0);
    expect(m.view.awaitingTakeout).toBe(true);
    expect(field(m, 6).hp).toBe(99);
    expect(events).toContainEqual({ type: 'player.busted', playerId: 'alice', reason: 'overshot 30' });
  });

  it('wins exactly in Gotcha and allows crossing the target when exact finish is off', () => {
    const exact = newMatch({ mode: 'gotcha', targetScore: 30 });
    play(exact, '20', '10');
    expect(exact.view.winnerId).toBe('alice');
    for (const config of [{ mode: 'normal' }, { mode: 'gotcha', exactFinish: false }]) {
      const m = newMatch({ ...config, targetScore: 30 });
      play(m, '20', 'D6');
      expect(m.view.winnerId).toBe('alice');
    }
  });
});
