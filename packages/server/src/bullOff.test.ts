import { beforeEach, describe, expect, it } from 'vitest';
import { BullOffCommandSchema, BullOffStartSchema } from '@darts/schema';
import { dart, players, resetDartIds } from '../../engine/src/testkit.ts';
import { BullOff } from './bullOff.ts';

beforeEach(resetDartIds);
const start = (...names: string[]) => new BullOff('bull-off', players(...names));
function hit(session: BullOff, label: string, distanceMm?: number): void {
  const shot = dart(label);
  shot.coords = distanceMm === undefined ? null : { x: distanceMm, y: 0 };
  expect(session.record(shot)).toBe(true);
  expect(session.next()).toBe(true);
}
const order = (session: BullOff) => session.view.groups.flat();

describe('bull-off ordering', () => {
  it('ranks the whole lineup by distance, not dart score', () => {
    const session = start('Alice', 'Bob', 'Carol');
    hit(session, 'T20', 102);
    hit(session, 'S1', 35);
    hit(session, 'S20', 70);
    expect(session.view.complete).toBe(true);
    expect(order(session)).toEqual(['bob', 'carol', 'alice']);
  });

  it('uses both axes in board millimetres', () => {
    const session = start('Alice', 'Bob');
    const shot = dart('S1'); shot.coords = { x: 30, y: 40 };
    session.record(shot); session.next(); hit(session, 'S20', 55);
    expect(session.view.results.alice?.distanceMm).toBe(50);
    expect(order(session)).toEqual(['alice', 'bob']);
  });

  it('measures D20 at 165 mm rather than scaling an already converted point again', () => {
    const session = start('Alice', 'Bob');
    const shot = dart('D20'); shot.coords = { x: 0, y: 165 };
    session.record(shot);
    expect(session.view.results.alice).toMatchObject({ label: 'D20', distanceMm: 165, band: 5 });
    expect(session.view.retry).toBe(false);
    session.next();
    hit(session, 'S1', 40);
    expect(session.view.complete).toBe(true);
    expect(order(session)).toEqual(['bob', 'alice']);
  });

  it('requires reverse-order rethrows for equal bull rings, regardless of distance', () => {
    const session = start('Alice', 'Bob');
    hit(session, 'BULL', 1); hit(session, 'BULL', 6);
    expect(session.view).toMatchObject({ complete: false, round: 2, queue: ['bob', 'alice'] });
    hit(session, '25', 10); hit(session, '25', 15);
    expect(session.view.queue).toEqual(['alice', 'bob']);
    hit(session, '25'); hit(session, 'BULL');
    expect(order(session)).toEqual(['bob', 'alice']);
    expect(session.view.complete).toBe(true);
  });

  it('resolves only tied places while preserving already decided positions', () => {
    const session = start('Alice', 'Bob', 'Carol', 'Dave', 'Eve');
    hit(session, 'BULL'); hit(session, '25'); hit(session, '25');
    hit(session, 'S1', 40); hit(session, 'S20', 40);
    expect(session.view.queue).toEqual(['carol', 'bob']);
    hit(session, 'S1', 25); hit(session, 'S20', 45);
    expect(session.view.queue).toEqual(['eve', 'dave']);
    hit(session, 'S1', 30); hit(session, 'BULL');
    expect(session.view.complete).toBe(true);
    expect(order(session)).toEqual(['alice', 'carol', 'bob', 'dave', 'eve']);
  });

  it('ties indistinguishable distances to a tenth of a millimetre', () => {
    const session = start('Alice', 'Bob');
    hit(session, 'S1', 40.01); hit(session, 'S20', 40.04);
    expect(session.view.complete).toBe(false);
    expect(session.view.queue).toEqual(['bob', 'alice']);
  });

  it('works without coordinates and allows explicit measurements to resolve same-zone hits', () => {
    const session = start('Alice', 'Bob', 'Carol');
    hit(session, 'S1'); hit(session, 'D20'); hit(session, 'S20', 125);
    expect(session.view.groups).toEqual([['alice', 'carol'], ['bob']]);
    expect(session.view.queue).toEqual(['carol', 'alice']);
    session.measure(45); session.next(); session.measure(30); session.next();
    expect(order(session)).toEqual(['alice', 'carol', 'bob']);
    expect(session.view.complete).toBe(true);
  });

  it('retries a bounce-out rather than using it to select a starter', () => {
    const session = start('Alice', 'Bob');
    hit(session, 'MISS');
    expect(session.view).toMatchObject({ activePlayerId: 'alice', complete: false, retry: false });
    hit(session, '25'); hit(session, 'S1', 35);
    expect(order(session)).toEqual(['alice', 'bob']);
  });

  it('can compare a dart outside the scoring rings when its board position is known', () => {
    const session = start('Alice', 'Bob');
    hit(session, 'MISS', 190); hit(session, 'D1', 165);
    expect(session.view.complete).toBe(true);
    expect(order(session)).toEqual(['bob', 'alice']);
  });

  it('holds one dart, ignores extra and duplicate detections, and ignores empty takeout', () => {
    const session = start('Alice', 'Bob');
    const first = dart('25'); session.record(first);
    expect(session.view).toMatchObject({ awaitingTakeout: true, activePlayerId: 'alice' });
    const extra = dart('BULL'); expect(session.record(extra)).toBe(false);
    session.next(); expect(session.next()).toBe(false);
    expect(session.record(first)).toBe(false); expect(session.record(extra)).toBe(false);
    expect(session.view.activePlayerId).toBe('bob');
  });

  it('undoes a final dart and a tie-break round boundary without stale results', () => {
    const session = start('Alice', 'Bob');
    hit(session, '25'); hit(session, '25');
    session.undo();
    expect(session.view).toMatchObject({ round: 1, queue: ['alice', 'bob'], activePlayerId: 'bob' });
    expect(session.view.results.bob).toBeUndefined();
    hit(session, 'BULL'); expect(session.view.complete).toBe(true);
    session.undo(); expect(session.view.complete).toBe(false);
    session.measure(40); session.next(); expect(order(session)).toEqual(['alice', 'bob']);
  });

  it('does not expose mutable session data and validates manual measurements and rosters', () => {
    const session = start('Alice', 'Bob');
    session.view.groups[0]!.reverse(); expect(order(session)).toEqual(['alice', 'bob']);
    for (const bad of [-1, 226, Infinity, NaN]) expect(() => session.measure(bad)).toThrow();
    expect(() => start('Alice')).toThrow(); expect(() => start('Alice', 'Alice')).toThrow();
    expect(BullOffStartSchema.safeParse({ playerIds: ['alice', 'alice'] }).success).toBe(false);
    expect(BullOffCommandSchema.safeParse({ type: 'MEASURE', distanceMm: -1 }).success).toBe(false);
  });
});
