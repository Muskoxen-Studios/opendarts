import { describe, it, expect, beforeEach } from 'vitest';
import type { GameConfig } from '@darts/schema';
import { Match } from './match.ts';
import { play, players, resetDartIds } from './testkit.ts';

/**
 * Ending a match early hands it to whoever is closest to winning, which means
 * something different in every game -- lowest score in X01, highest in Gotcha.
 */

const ROSTER = players('Alice', 'Bob');

const X01: GameConfig = {
  gameType: 'x01',
  startScore: 501,
  inMode: 'straight',
  outMode: 'double',
  legsToWin: 1,
  setsToWin: 1,
  roundLimit: null,
  legEnd: 'first',
  perPlayer: {},
};

/**
 * A nine-dart leg for whoever is at the oche, with the opponent's blank turns
 * interleaved -- otherwise the darts silently belong to whoever the engine
 * handed over to.
 */
function nineDarter(m: Match): void {
  const turns = [
    ['T20', 'T20', 'T20'],
    ['T20', 'T20', 'T20'],
    ['T20', 'T19', 'D12'],
  ];
  turns.forEach((turn, i) => {
    play(m, ...turn);
    if (i < turns.length - 1) play(m, 'MISS', 'MISS', 'MISS');
  });
}

function start(config: GameConfig, roster = ROSTER): Match {
  const m = new Match('e1', roster, config);
  m.apply({ type: 'START' });
  return m;
}

beforeEach(resetDartIds);

describe('ending a match early', () => {
  it.each(['roundtheworld', 'segmenttraining'] as const)('ranks successful marks/hits in %s', gameType => {
    const m = new Match('training-end', ROSTER, { gameType, segment: 1, mode: 'triple' });
    m.apply({ type: 'START' }); play(m, 'MISS', 'MISS', 'MISS', 'T1');
    m.apply({ type: 'END_MATCH' }); expect(m.view.winnerId).toBe('bob');
  });
  it('ends Random Checkout by actual legs checked out', () => {
    const m = new Match('random-end', ROSTER, { gameType: 'randomcheckout', checkoutMin: 20, checkoutMax: 20 });
    m.apply({ type: 'START' }); play(m, 'D10'); m.apply({ type: 'END_MATCH' }); expect(m.view.winnerId).toBe('alice');
  });
  it("ends Bob's 27 by the solo score", () => {
    const m = new Match('bob-end', players('Alice'), { gameType: 'bobs27' });
    m.apply({ type: 'START' }); play(m, 'D1'); m.apply({ type: 'END_MATCH' }); expect(m.view.winnerId).toBe('alice');
  });
  it('ends 121 by final level, recording no win before any progress', () => {
    const m = new Match('121-end', ROSTER, { gameType: '121' });
    m.apply({ type: 'START' }); play(m, 'T20', 'T19', 'D2'); m.apply({ type: 'END_MATCH' }); expect(m.view.winnerId).toBe('alice');
    const blank = new Match('121-blank', ROSTER, { gameType: '121' });
    blank.apply({ type: 'START' }); blank.apply({ type: 'END_MATCH' }); expect(blank.view.winnerId).toBeNull();
  });
  it('gives Count Up to the highest score', () => {
    const m = new Match('countup-end', ROSTER, { gameType: 'countup' });
    m.apply({ type: 'START' });
    play(m, 'S5', 'MISS', 'MISS', 'T20');
    m.apply({ type: 'END_MATCH' });
    expect(m.view.winnerId).toBe('bob');
  });
  it('gives Around the Clock to the most completed targets rather than board points', () => {
    const m = new Match('clock-end', ROSTER, { gameType: 'aroundtheclock' });
    m.apply({ type: 'START' });
    play(m, 'T20', 'T20', 'T20', 'S1');
    m.apply({ type: 'END_MATCH' });
    expect(m.view.winnerId).toBe('bob');
  });
  it('gives X01 to the lowest remaining score', () => {
    const m = start(X01);
    play(m, 'T20', 'T20', 'T20'); // Alice on 321
    play(m, 'S1', 'S1', 'S1'); // Bob on 498

    m.apply({ type: 'END_MATCH' });
    expect(m.view.status).toBe('finished');
    expect(m.view.winnerId).toBe('alice');
  });

  it('prefers legs already won over the current leg', () => {
    const m = start({ ...X01, legsToWin: 3 });
    // Alice takes the first leg from 501 in nine darts.
    nineDarter(m);
    expect(m.view.players.find((p) => p.playerId === 'alice')?.legsWon).toBe(1);

    // Bob starts the second leg and leads it, but a leg in hand outranks it.
    expect(m.view.activePlayerId).toBe('bob');
    play(m, 'T20', 'T20', 'T20');
    m.apply({ type: 'END_MATCH' });
    expect(m.view.winnerId).toBe('alice');
  });

  it('gives Gotcha to the highest score, because it counts up', () => {
    const m = start({
      gameType: 'gotcha',
      target: 301,
      knockback: 'zero',
      exactFinish: true,
      handicaps: {},
      legsToWin: 1,
      setsToWin: 1,
      roundLimit: null,
    });
    play(m, 'S5', 'S5', 'S5'); // Alice 15
    play(m, 'T20', 'T20', 'T20'); // Bob 180

    m.apply({ type: 'END_MATCH' });
    expect(m.view.winnerId).toBe('bob');
  });

  it('gives Cricket to whoever has closed the most', () => {
    const m = start({
      gameType: 'cricket',
      variant: 'standard',
      targets: [20, 19, 18, 17, 16, 15, 25],
      scoring: true,
      legsToWin: 1,
      setsToWin: 1,
      roundLimit: null,
    });
    play(m, 'T20', 'T19', 'T18'); // Alice closes three
    play(m, 'S20', 'MISS', 'MISS'); // Bob has one mark

    m.apply({ type: 'END_MATCH' });
    expect(m.view.winnerId).toBe('alice');
  });

  it('gives Golf to the most Stableford points', () => {
    const m = start({
      gameType: 'golf',
      holes: 18,
      par: 4,
      handicaps: { alice: 0, bob: 0 },
      legsToWin: 1,
      setsToWin: 1,
      roundLimit: null,
    });
    play(m, 'MISS', 'MISS', 'MISS'); // Alice: nothing yet
    play(m, 'S1', 'S2', 'S3'); // Bob: three albatrosses

    m.apply({ type: 'END_MATCH' });
    expect(m.view.winnerId).toBe('bob');
  });

  it('gives Even/Odd to the higher score', () => {
    const m = start({
      gameType: 'evenodd',
      startingScore: 0,
      targetScore: 1000,
      legsToWin: 1,
      setsToWin: 1,
      roundLimit: null,
    });
    play(m, 'S4', 'MISS', 'MISS'); // Alice: +4
    play(m, 'S5', 'MISS', 'MISS'); // Bob: -5

    m.apply({ type: 'END_MATCH' });
    expect(m.view.winnerId).toBe('alice');
  });

  it('gives Conquest to the independent leader with the most territory', () => {
    const m = new Match('conquest-end', ROSTER, { gameType: 'conquest', multipliers: true });
    m.apply({ type: 'START' });
    play(m, 'T1', 'MISS', 'MISS');
    m.apply({ type: 'END_MATCH' });
    expect(m.view.winnerId).toBe('alice');
  });

  it('does nothing to a match that is already over', () => {
    const m = start(X01);
    nineDarter(m);
    expect(m.view.winnerId).toBe('alice');

    m.apply({ type: 'END_MATCH' });
    expect(m.view.winnerId).toBe('alice');
  });

  it('is an ordinary log command, so undoing the last dart replays it', () => {
    const m = start(X01);
    play(m, 'T20', 'T20', 'T20');
    play(m, 'S1', 'S1', 'S1');
    m.apply({ type: 'END_MATCH' });
    expect(m.view.winnerId).toBe('alice');

    // Undo removes Alice's last dart; the concession still folds afterwards and
    // still lands on Alice, who remains ahead.
    m.apply({ type: 'UNDO' });
    expect(m.log.filter((c) => c.type === 'THROW')).toHaveLength(5);
    expect(m.view.status).toBe('finished');
    expect(m.view.winnerId).toBe('alice');
  });
});
