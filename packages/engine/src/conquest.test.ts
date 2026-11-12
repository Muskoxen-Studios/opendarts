import { beforeEach, describe, expect, it } from 'vitest';
import { ConquestConfigSchema, SEGMENT_ORDER } from '@darts/schema';
import { conquestEngine } from './conquest.ts';
import { Match } from './match.ts';
import { dart, play, players, resetDartIds, throwCmd } from './testkit.ts';

beforeEach(resetDartIds);
function match(overrides = {}, names = ['Alice', 'Bob', 'Cara', 'Dan']) {
  const m = new Match('conquest', players(...names), { gameType: 'conquest', ...overrides });
  m.apply({ type: 'START' });
  return m;
}
function scenario(overrides = {}) {
  const cfg = ConquestConfigSchema.parse({ gameType: 'conquest', ...overrides });
  const state = conquestEngine.createInitialState(players('Alice', 'Bob', 'Cara', 'Dan'), cfg);
  state.base.status = 'playing';
  return { cfg, state };
}
function field(s: ReturnType<typeof scenario>['state'], n: number, lane = 'outer') {
  return s.territories.find((t) => t.number === n && t.lane === lane)!;
}

describe('Conquest', () => {
  it('defaults and validates equally spaced starting homes', () => {
    expect(ConquestConfigSchema.parse({ gameType: 'conquest' })).toMatchObject({
      defeatMode: 'elimination', comebackFoothold: false, splitTerritories: false,
      multipliers: false, fortifiedHomes: false, roundLimit: null,
    });
    for (const count of [2, 4, 5, 10, 20]) {
      const m = match({}, Array.from({ length: count }, (_, i) => `P${i}`));
      expect(m.view.players.map((p) => p.detail.home)).toEqual(
        Array.from({ length: count }, (_, i) => `${SEGMENT_ORDER[i * 20 / count]}:outer`));
    }
    expect(() => match({}, ['A', 'B', 'C'])).toThrow('equally spaced');
  });
  it('captures immediately and permits expansion on the next dart; bulls and remote hits do not capture', () => {
    const m = match({ multipliers: true });
    play(m, 'T1', 'T18', 'BULL');
    expect(m.view.players[0]!.score).toBe(3);
    play(m, 'T9', '25', 'MISS'); // Bob owns 6, cannot capture remote 9.
    expect(m.view.players[1]!.score).toBe(1);
  });
  it('counts literal hits by default and holds the turn for takeout', () => {
    const m = match();
    m.apply(throwCmd('T1')); m.apply(throwCmd('D1')); m.apply(throwCmd('S1'));
    expect(m.view.players[0]!.score).toBe(2);
    expect(m.view.activePlayerId).toBe('alice');
    expect(m.view.awaitingTakeout).toBe(true);
    m.apply(throwCmd('T18'));
    expect(m.view.turn.throws).toHaveLength(3);
    m.apply({ type: 'ADVANCE_TURN' });
    expect(m.view.activePlayerId).toBe('bob');
  });
  it('remote sabotage resets progress, while adjacent sabotage starts a new attack', () => {
    const { state, cfg } = scenario();
    field(state, 1).attackerId = 'bob'; field(state, 1).marks = 2;
    const next = conquestEngine.reduce(state, { type: 'THROW', throw: dart('S1') }, cfg).state;
    expect(field(next, 1)).toMatchObject({ attackerId: 'alice', marks: 1 });
    expect(field(state, 1).marks).toBe(2); // Previous state stays immutable.
    field(state, 9).attackerId = 'bob'; field(state, 9).marks = 2;
    const remote = conquestEngine.reduce(state, { type: 'THROW', throw: dart('S9') }, cfg).state;
    expect(field(remote, 9)).toMatchObject({ attackerId: null, marks: 0 });
  });
  it('friendly hits defend ordinary territory', () => {
    const { state, cfg } = scenario();
    field(state, 20).attackerId = 'bob'; field(state, 20).marks = 2;
    const next = conquestEngine.reduce(state, { type: 'THROW', throw: dart('S20') }, cfg).state;
    expect(field(next, 20).marks).toBe(0);
  });
  it('eliminates a faction, captures all its land and skips its turns', () => {
    const { state, cfg } = scenario({ multipliers: true, splitTerritories: true });
    field(state, 13).ownerId = 'alice'; field(state, 10).ownerId = 'bob';
    field(state, 10, 'inner').ownerId = 'bob';
    field(state, 15).attackerId = 'bob'; field(state, 15).marks = 2;
    field(state, 6).attackerId = 'alice'; field(state, 6).marks = 2;
    const next = conquestEngine.reduce(state, { type: 'THROW', throw: dart('S6') }, cfg).state;
    expect(next.players.bob!.faction).toBeNull();
    expect(field(next, 10).ownerId).toBe('alice');
    expect(field(next, 6).ownerId).toBe('alice');
    expect(field(next, 10, 'inner').ownerId).toBe('alice');
    expect(field(next, 15)).toMatchObject({ ownerId: null, attackerId: null, marks: 0 });
    expect(field(next, 3).ownerId).toBe('cara');
    const advanced = conquestEngine.reduce(next, { type: 'NEXT_PLAYER' }, cfg).state;
    expect(advanced.base.players[advanced.base.activeIndex]!.id).toBe('cara');
  });
  it('converts entire factions, transferring land and attacks; allies share counters', () => {
    const { state, cfg } = scenario({ defeatMode: 'conversion', multipliers: true });
    state.players.cara!.faction = 'bob'; field(state, 3).ownerId = 'bob';
    field(state, 13).ownerId = 'alice'; field(state, 10).ownerId = 'bob';
    field(state, 15).attackerId = 'bob'; field(state, 15).marks = 1;
    const next = conquestEngine.reduce(state, { type: 'THROW', throw: dart('T6') }, cfg).state;
    expect(next.players.bob!.faction).toBe('alice');
    expect(next.players.cara!.faction).toBe('alice');
    expect(field(next, 10).ownerId).toBe('alice');
    expect(field(next, 15).attackerId).toBe('alice');
    next.base.activeIndex = 1; next.base.turn = [];
    const allied = conquestEngine.reduce(next, { type: 'THROW', throw: dart('D15') }, cfg).state;
    expect(field(allied, 15).ownerId).toBe('alice');
    expect(allied.base.status).toBe('playing'); // Dan still independent.
  });
  it.each(['elimination', 'conversion'] as const)('allows independent comeback in %s mode', (defeatMode) => {
    const { state, cfg } = scenario({ defeatMode, comebackFoothold: true });
    state.players.alice!.faction = defeatMode === 'elimination' ? null : 'bob';
    field(state, 20).ownerId = 'bob'; field(state, 20).marks = 2; field(state, 20).attackerId = 'alice';
    const next = conquestEngine.reduce(state, { type: 'THROW', throw: dart('S20') }, cfg).state;
    expect(next.players.alice!.faction).toBe('alice');
    expect(field(next, 20).ownerId).toBe('alice');
  });
  it('keeps foothold players in rotation but ends when one independent faction remains', () => {
    const { state, cfg } = scenario({ comebackFoothold: true });
    state.players.bob!.faction = null;
    const next = conquestEngine.reduce(state, { type: 'NEXT_PLAYER' }, cfg).state;
    expect(next.base.activeIndex).toBe(1);
    state.players.cara!.faction = null; state.players.dan!.faction = null;
    const won = conquestEngine.reduce(state, { type: 'THROW', throw: dart('MISS') }, cfg).state;
    expect(won.base.winnerId).toBe('alice');
  });
  it('fortified home damage survives defense, remote sabotage and loss of adjacency', () => {
    const { state, cfg } = scenario({ fortifiedHomes: true, multipliers: true, comebackFoothold: true });
    field(state, 6).marks = 6; field(state, 6).attackerId = 'cara';
    const remote = conquestEngine.reduce(state, { type: 'THROW', throw: dart('T6') }, cfg).state;
    expect(field(remote, 6).marks).toBe(6);
    remote.base.activeIndex = 1; remote.base.turn = [];
    const defense = conquestEngine.reduce(remote, { type: 'THROW', throw: dart('T6') }, cfg).state;
    expect(field(defense, 6).marks).toBe(6);
    defense.base.activeIndex = 0; defense.base.turn = []; field(defense, 13).ownerId = 'alice';
    const captured = conquestEngine.reduce(defense, { type: 'THROW', throw: dart('T6') }, cfg).state;
    expect(captured.players.bob!.faction).toBeNull();
    expect(field(captured, 6)).toMatchObject({ ownerId: 'alice', homeId: null, marks: 0, required: 3 });
    expect(conquestEngine.view(captured, cfg, 'test').players[1]!.detail.canComeback).toBe(false);
  });
  it('splits inner/outer ownership and maps multiplier rings to the correct territory without coordinates', () => {
    const { state, cfg } = scenario({ splitTerritories: true, multipliers: true });
    expect(state.territories).toHaveLength(40);
    const outer = conquestEngine.reduce(state, { type: 'THROW', throw: dart('D1') }, cfg).state;
    expect(field(outer, 1).marks).toBe(2);
    expect(field(outer, 1, 'inner').marks).toBe(0);
    const inner = conquestEngine.reduce(outer, { type: 'THROW', throw: dart('T20') }, cfg).state;
    expect(field(inner, 20, 'inner').ownerId).toBe('alice');
    const neighbour = conquestEngine.reduce(inner, { type: 'THROW', throw: dart('T1') }, cfg).state;
    expect(field(neighbour, 1, 'inner').ownerId).toBe('alice');
    expect(field(neighbour, 1).ownerId).toBeNull();
  });
  it('awards wins, resets legs and supports undo/correction across capture and turn boundaries', () => {
    const m = match({ multipliers: true }, ['Alice', 'Bob']);
    play(m, 'T1', 'T18', 'T4');
    m.apply({ type: 'UNDO' });
    expect(m.view.players[0]!.score).toBe(3);
    const id = m.log.find((c) => c.type === 'THROW')!;
    if (id.type !== 'THROW') throw new Error('missing throw');
    m.apply({ type: 'CORRECT_THROW', throwId: id.throw.id, segment: { number: 0, ring: 'MISS' } });
    expect(m.view.players[0]!.score).toBe(1);
    const restored = Match.fromLog(m.matchId, m.players, m.config, [...m.log]);
    expect(restored.view).toEqual(m.view);
    const { state, cfg } = scenario({ multipliers: true, legsToWin: 2 });
    state.players.cara!.faction = null; state.players.dan!.faction = null;
    field(state, 13).ownerId = 'alice';
    const next = conquestEngine.reduce(state, { type: 'THROW', throw: dart('T6') }, cfg).state;
    expect(next.base.legsWon.alice).toBe(1);
    expect(next.base.leg).toBe(2);
    expect(next.players.bob!.faction).toBe('bob');
    expect(next.territories.filter((t) => t.ownerId)).toHaveLength(4);
  });
  it.each(['elimination', 'conversion'] as const)('wins a complete %s leg by taking the last enemy home', (defeatMode) => {
    const m = match({ multipliers: true, defeatMode }, ['Alice', 'Bob']);
    // Clockwise from Alice's 20 to Bob's 3, with blank defending turns.
    const route = ['T1', 'T18', 'T4', 'T13', 'T6', 'T10', 'T15', 'T2', 'T17', 'T3'];
    route.forEach((label, i) => {
      play(m, label);
      if ((i + 1) % 3 === 0) play(m, 'MISS', 'MISS', 'MISS');
    });
    expect(m.view.winnerId).toBe('alice');
    expect(m.view.status).toBe('finished');
    expect(m.view.players[1]!.detail.factionId).toBe(defeatMode === 'conversion' ? 'alice' : null);
    expect(m.allEvents.filter((e) => e.type === 'match.won')).toHaveLength(1);
    m.apply({ type: 'UNDO' });
    expect(m.view.status).toBe('playing');
    expect(m.view.players[1]!.detail.factionId).toBe('bob');
  });
  it('requires three inner singles when split multipliers are disabled, without diagonal adjacency', () => {
    const { state, cfg } = scenario({ splitTerritories: true });
    const innerDart = { ...dart('S20'), segment: { number: 20, ring: 'SINGLE_INNER' as const } };
    const a = conquestEngine.reduce(state, { type: 'THROW', throw: dart('T1') }, cfg).state;
    expect(field(a, 1, 'inner').marks).toBe(0); // Diagonal from outer 20.
    let next = state;
    for (let i = 0; i < 3; i++) next = conquestEngine.reduce(next, { type: 'THROW', throw: innerDart }, cfg).state;
    expect(field(next, 20, 'inner').ownerId).toBe('alice');
  });

  it('honours round limits, restarts and roster departures; late joins cannot move homes', () => {
    const m = match({ roundLimit: 1, multipliers: true });
    play(m, 'T1', 'T18', 'MISS');
    for (let i = 0; i < 3; i++) play(m, 'MISS', 'MISS', 'MISS');
    expect(m.view.winnerId).toBe('alice');
    const fresh = match({ multipliers: true });
    play(fresh, 'T1'); fresh.apply({ type: 'RESTART_LEG' });
    expect(fresh.view.players[0]!.score).toBe(1);
    fresh.apply({ type: 'ADD_PLAYER', player: players('Eve')[0]! });
    expect(fresh.view.players).toHaveLength(4);
    fresh.apply({ type: 'REMOVE_PLAYER', playerId: 'alice' });
    expect(fresh.view.players).toHaveLength(3);
    expect(fresh.view.activePlayerId).toBe('bob');
    const territories = fresh.view.players[0]!.detail.territories as { id: string; ownerId: string | null }[];
    expect(territories.find((t) => t.id === '20:outer')!.ownerId).toBeNull();
  });
});

describe('Power of God', () => {
  function losingScenario(overrides = {}) {
    const setup = scenario(overrides);
    field(setup.state, 13).ownerId = 'bob';
    field(setup.state, 19).ownerId = 'cara';
    field(setup.state, 14).ownerId = 'dan';
    return setup;
  }
  function hit(s: ReturnType<typeof scenario>['state'], cfg: ReturnType<typeof scenario>['cfg'], label: string) {
    return conquestEngine.reduce(s, { type: 'THROW', throw: dart(label) }, cfg).state;
  }
  it('requires the inner bull and a uniquely last independent leader', () => {
    const { state, cfg } = losingScenario();
    expect(hit(state, cfg, '25').players.alice!.godPower).toBe(false);
    expect(hit(state, cfg, 'BULL').players.alice!.godPower).toBe(true);
    state.base.activeIndex = 1;
    expect(hit(state, cfg, 'BULL').players.bob!.godPower).toBe(false);
    const tied = scenario();
    expect(hit(tied.state, tied.cfg, 'BULL').players.alice!.godPower).toBe(false);
  });
  it.each(['elimination', 'conversion'] as const)('takes the entire faction territory while applying %s to its players', (defeatMode) => {
    const { state, cfg } = losingScenario({ defeatMode, fortifiedHomes: true, splitTerritories: true });
    state.players.cara!.faction = 'bob';
    field(state, 3).ownerId = 'bob'; field(state, 19).ownerId = 'bob';
    field(state, 6, 'inner').ownerId = 'bob';
    const armed = hit(state, cfg, 'BULL');
    expect(conquestEngine.view(armed, cfg, 'test').players[0]!.detail.godPower).toBe(true);
    const captured = hit(armed, cfg, 'S6');
    expect(field(captured, 6)).toMatchObject({ ownerId: 'alice', marks: 0, homeId: null, required: 3 });
    expect(captured.players.bob!.faction).toBe(defeatMode === 'conversion' ? 'alice' : null);
    expect(captured.players.cara!.faction).toBe(defeatMode === 'conversion' ? 'alice' : null);
    for (const [number, lane] of [[6, 'outer'], [13, 'outer'], [3, 'outer'], [19, 'outer'], [6, 'inner']] as const) {
      expect(field(captured, number, lane).ownerId).toBe('alice');
    }
    expect(field(captured, 13, 'inner').ownerId).toBeNull();
    expect(field(captured, 11).ownerId).toBe('dan');
    expect(captured.players.alice!.godPower).toBe(false);
    expect(armed.players.bob!.faction).toBe('bob');
  });
  it('keeps the charge through misses, friendly hits and turn boundaries without stacking', () => {
    const { state, cfg } = losingScenario();
    let next = hit(hit(hit(state, cfg, 'BULL'), cfg, 'BULL'), cfg, 'MISS');
    expect(next.base.turnEnded).toBe(true);
    next = conquestEngine.reduce(next, { type: 'ADVANCE_TURN' }, cfg).state;
    for (let i = 0; i < 3; i++) next = conquestEngine.reduce(next, { type: 'NEXT_PLAYER' }, cfg).state;
    expect(next.base.players[next.base.activeIndex]!.id).toBe('alice');
    next = hit(next, cfg, 'S20');
    expect(next.players.alice!.godPower).toBe(true);
    next = hit(next, cfg, 'S6');
    expect(next.players.bob!.faction).toBeNull();
    expect(next.players.alice!.godPower).toBe(false);
    // A second remote capital needs another bull, even if Alice is still last.
    next = hit(next, cfg, 'S3');
    expect(next.players.cara!.faction).toBe('cara');
  });
  it('removes the charge immediately when the player catches up or ties for last', () => {
    const { state, cfg } = losingScenario({ multipliers: true });
    const armed = hit(state, cfg, 'BULL');
    const tied = hit(armed, cfg, 'T1');
    expect(tied.players.alice!.godPower).toBe(false);
    const view = conquestEngine.view(tied, cfg, 'test');
    expect(view.players[0]!.detail.canInvokeGod).toBe(false);
    expect(view.turn.hints).toEqual([]);
    expect(hit(tied, cfg, 'S6').players.bob!.faction).toBe('bob');
  });
  it('removes an armed player’s charge when another player changes the standings', () => {
    const { state, cfg } = losingScenario({ multipliers: true });
    const armed = hit(state, cfg, 'BULL');
    armed.base.activeIndex = 2; armed.base.turn = [];
    // Cara takes Bob's non-capital 13, leaving Bob tied with Alice on one.
    field(armed, 4).ownerId = 'cara';
    const tied = hit(armed, cfg, 'T13');
    expect(tied.players.alice!.godPower).toBe(false);
  });
  it('uses faction standings, excludes converted and eliminated players, and clears power on defeat', () => {
    const { state, cfg } = losingScenario({ defeatMode: 'conversion', multipliers: true, comebackFoothold: true });
    state.players.cara!.faction = 'alice'; field(state, 3).ownerId = 'bob';
    state.players.dan!.faction = null; field(state, 11).ownerId = null; field(state, 14).ownerId = null;
    state.base.activeIndex = 2;
    expect(hit(state, cfg, 'BULL').players.cara!.godPower).toBe(false);
    state.base.activeIndex = 3;
    expect(hit(state, cfg, 'BULL').players.dan!.godPower).toBe(false);
    state.base.activeIndex = 0;
    const armed = hit(state, cfg, 'BULL');
    expect(armed.players.alice!.godPower).toBe(true);
    armed.base.activeIndex = 1; armed.base.turn = [];
    field(armed, 1).ownerId = 'bob';
    const defeated = hit(armed, cfg, 'T20');
    expect(defeated.players.alice!.faction).toBe('bob');
    expect(defeated.players.alice!.godPower).toBe(false);
  });
  it('on a split board, only the actual outer home is an instant-kill target', () => {
    const { state, cfg } = losingScenario({ splitTerritories: true, multipliers: true });
    const armed = hit(state, cfg, 'BULL');
    const inner = hit(armed, cfg, 'T6');
    expect(inner.players.bob!.faction).toBe('bob');
    expect(inner.players.alice!.godPower).toBe(true);
    const outer = hit(inner, cfg, 'D6');
    expect(outer.players.bob!.faction).toBeNull();
  });
  it('highlights bull while eligible and remote enemy capitals while armed', () => {
    const { state, cfg } = losingScenario();
    const before = conquestEngine.view(state, cfg, 'test');
    expect(before.turn.hints).toEqual(['BULL', 'BULL', 'BULL']);
    const armed = hit(state, cfg, 'BULL');
    const view = conquestEngine.view(armed, cfg, 'test');
    expect(view.turn.hints).toEqual([]);
    expect((view.players[0]!.detail.territories as { id: string; capturable: boolean }[])
      .find((t) => t.id === '6:outer')!.capturable).toBe(true);
  });
  it('can win a match, and undo/correction replay restores or removes the charge', () => {
    const m = match({ multipliers: true, fortifiedHomes: true }, ['Alice', 'Bob']);
    play(m, 'T1', 'MISS', 'MISS'); // Alice 2, Bob 1: Bob uniquely last.
    play(m, 'BULL', 'MISS', 'MISS');
    expect(m.view.players[1]!.detail.godPower).toBe(true);
    play(m, 'MISS', 'MISS', 'MISS');
    m.apply(throwCmd('S20')); // Bob instantly takes Alice's fortified home remotely.
    expect(m.view.winnerId).toBe('bob');
    expect(m.view.players[1]!.score).toBe(3); // Both of Alice's fields transfer.
    m.apply({ type: 'UNDO' });
    expect(m.view.players.map((p) => p.score)).toEqual([2, 1]);
    expect(m.view.status).toBe('playing');
    expect(m.view.players[1]!.detail.godPower).toBe(true);
    const bull = m.log.find((c) => c.type === 'THROW' && c.throw.segment.ring === 'BULL');
    if (bull?.type !== 'THROW') throw new Error('missing bull');
    m.apply({ type: 'CORRECT_THROW', throwId: bull.throw.id, segment: { number: 25, ring: 'OUTER_BULL' } });
    expect(m.view.players[1]!.detail.godPower).toBe(false);
    expect(Match.fromLog(m.matchId, m.players, m.config, [...m.log]).view).toEqual(m.view);
    m.apply({ type: 'RESTART_LEG' });
    expect(m.view.players.every((p) => !p.detail.godPower)).toBe(true);
  });
});
