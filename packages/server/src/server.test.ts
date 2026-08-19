import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { segmentValue, type GameConfig, type Segment } from '@darts/schema';
import { seg } from '../../engine/src/testkit.ts';
import { openDatabase } from './db.ts';
import { MatchManager, type ServerEvent } from './matchManager.ts';
import { Store } from './store.ts';

const X01: GameConfig = {
  gameType: 'x01',
  startScore: 501,
  inMode: 'straight',
  outMode: 'double',
  legsToWin: 1,
  setsToWin: 1,
  legEnd: 'first',
  perPlayer: {},
};

let db: DatabaseSync;
let store: Store;
let events: ServerEvent[];
let manager: MatchManager;

function throwAt(label: string, coords: { x: number; y: number } | null = null): void {
  const segment: Segment = seg(label);
  manager.apply({
    type: 'THROW',
    throw: {
      id: `${label}-${Math.random()}`,
      ts: new Date().toISOString(),
      segment,
      value: segmentValue(segment),
      coords,
      source: 'simulator',
    },
  });
}

/** Alice wins a 501 leg in nine darts; Bob misses throughout. */
function nineDartLeg(): void {
  const script = [
    'T20', 'T20', 'T20', 'MISS', 'MISS', 'MISS',
    'T20', 'T20', 'T20', 'MISS', 'MISS', 'MISS',
    'T20', 'T19', 'D12',
  ];
  for (const label of script) throwAt(label);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  store = new Store(db);
  events = [];
  manager = new MatchManager(store, (e) => events.push(e));
});

describe('profiles', () => {
  it('creates and lists local profiles with no login of any kind', () => {
    store.createProfile('Alice');
    store.createProfile('Bob', '#ff0000');
    const list = store.listProfiles();
    expect(list.map((p) => p.name)).toEqual(['Alice', 'Bob']);
    expect(list[1]?.color).toBe('#ff0000');
  });

  it('soft-deletes so historical matches survive', () => {
    const alice = store.createProfile('Alice');
    const bob = store.createProfile('Bob');
    manager.start(X01, [alice, bob].map(toPlayer));
    nineDartLeg();

    store.deleteProfile(alice.id);
    expect(store.listProfiles().map((p) => p.name)).toEqual(['Bob']);
    // The match still knows who played it.
    expect(store.listMatches()[0]?.players.map((p) => p.name)).toContain('Alice');
  });
});

describe('playing a match', () => {
  it('records the command log as the source of truth', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    throwAt('T20');
    const log = store.commandsFor(store.listMatches()[0]!.id);
    expect(log[0]?.type).toBe('START');
    expect(log[1]?.type).toBe('THROW');
  });

  it('keeps the persisted log in step with an undo', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    throwAt('T20');
    throwAt('T20');
    manager.apply({ type: 'UNDO' });

    const matchId = store.listMatches()[0]!.id;
    const log = store.commandsFor(matchId);
    expect(log.filter((c) => c.type === 'THROW')).toHaveLength(1);
    expect(manager.view?.players[0]?.score).toBe(441);
  });

  it('marks the match finished and records the winner', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    nineDartLeg();
    const summary = store.listMatches()[0];
    expect(summary?.endedAt).not.toBeNull();
    expect(summary?.winnerId).toBe(alice.id);
  });
});

describe('surviving a restart', () => {
  it('rebuilds an interrupted match from its log', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    throwAt('T20');
    throwAt('T20');
    const before = manager.view;

    // A fresh manager, as though the process had restarted.
    const revived = new MatchManager(store, () => {});
    const unfinished = store.findUnfinishedMatch();
    expect(unfinished).not.toBeNull();
    const view = revived.resume(unfinished!);

    expect(view?.players[0]?.score).toBe(before?.players[0]?.score);
    expect(view?.activePlayerId).toBe(before?.activePlayerId);
    expect(view?.turn.throws).toHaveLength(2);
  });
});

describe('projections', () => {
  it('writes career statistics when a match finishes', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    nineDartLeg();

    const career = store.careerFor(alice.id);
    expect(career.matchesWon).toBe(1);
    expect(career.count180).toBe(2);
    expect(career.bestLegDarts).toBe(9);
  });

  it('writes the throws projection with null coordinates', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    nineDartLeg();

    const rows = db
      .prepare('SELECT coords_json, segment_ring FROM throws')
      .all() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.coords_json === null)).toBe(true);
  });

  it('unlocks achievements and announces only the new ones', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    nineDartLeg();

    expect(unlockedIdsFor(alice.id)).toContain('maximum');
    expect(unlockedIdsFor(alice.id)).toContain('nine-darter');
  });

  it('does not re-announce an achievement already held', () => {
    const [alice, bob] = seedPlayers();

    manager.start(X01, [alice, bob]);
    nineDartLeg();
    events = [];

    manager.start(X01, [alice, bob]);
    nineDartLeg();

    expect(unlockedIdsFor(alice.id)).not.toContain('maximum');
  });
});

describe('live achievements', () => {
  it('announces an unlock the moment it happens, not at the end of the match', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);

    // Alice's opening 180. The match is nowhere near finished.
    throwAt('T20');
    throwAt('T20');
    expect(unlockedIdsFor(alice.id)).not.toContain('maximum');

    throwAt('T20');
    expect(unlockedIdsFor(alice.id)).toContain('maximum');
    expect(manager.view?.status).toBe('playing');
  });

  it('announces each achievement only once per match', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    nineDartLeg();
    const maximums = unlockedIdsFor(alice.id).filter((id) => id === 'maximum');
    expect(maximums).toHaveLength(1);
  });

  it('persists the unlock immediately, not at the end of the match', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    throwAt('T20'); throwAt('T20'); throwAt('T20');

    const held = store
      .readAchievements(alice.id)
      .filter((a) => a.unlockedAt !== null)
      .map((a) => a.achievementId);
    expect(held).toContain('maximum');
    expect(manager.view?.status).toBe('playing');
  });

  it('carries the details needed to render a celebration', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    throwAt('T20'); throwAt('T20'); throwAt('T20');

    const unlock = events.find(
      (e) => e.type === 'achievements.unlocked' && e.playerId === alice.id,
    );
    expect(unlock?.type === 'achievements.unlocked' && unlock.achievements[0]).toMatchObject({
      id: 'maximum',
      name: 'Maximum',
      icon: expect.any(String),
    });
  });
});

/** Achievement ids currently recorded as unlocked for a player. */
function heldBy(playerId: string): string[] {
  return store
    .readAchievements(playerId)
    .filter((a) => a.unlockedAt !== null)
    .map((a) => a.achievementId);
}

describe('achievement progress', () => {
  function goalOf(playerId: string, achievementId: string): number | undefined {
    return store.readAchievements(playerId).find((a) => a.achievementId === achievementId)?.goal;
  }
  function progressOf(playerId: string, achievementId: string): number | undefined {
    return store.readAchievements(playerId).find((a) => a.achievementId === achievementId)?.progress;
  }

  it('updates during a match, not only when it ends', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);

    throwAt('T20'); throwAt('T20'); throwAt('T20');
    expect(progressOf(alice.id, 'ton-80-club')).toBe(1);
    expect(goalOf(alice.id, 'ton-80-club')).toBe(10);
    expect(manager.view?.status).toBe('playing');
  });

  it('keeps counting across matches', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    nineDartLeg();                       // two maximums
    expect(progressOf(alice.id, 'ton-80-club')).toBe(2);

    manager.start(X01, [alice, bob]);
    throwAt('T20'); throwAt('T20'); throwAt('T20');
    expect(progressOf(alice.id, 'ton-80-club')).toBe(3);
  });

  it('keeps moving for an achievement already held before this match', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    nineDartLeg();
    expect(heldBy(alice.id)).toContain('maximum');

    // 'maximum' is held; its progress should still track further maximums.
    manager.start(X01, [alice, bob]);
    throwAt('T20'); throwAt('T20'); throwAt('T20');
    expect(progressOf(alice.id, 'ton-80-club')).toBe(3);
    expect(heldBy(alice.id)).toContain('maximum');
  });

  it('falls back to the goal after an undo', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    throwAt('T20'); throwAt('T20'); throwAt('T20');
    expect(progressOf(alice.id, 'ton-80-club')).toBe(1);
    manager.apply({ type: 'UNDO' });
    expect(progressOf(alice.id, 'ton-80-club')).toBe(0);
    expect(goalOf(alice.id, 'ton-80-club')).toBe(10);
  });
});

describe('undoing the throws that earned an achievement', () => {
  it('withdraws an achievement when the dart that earned it is undone', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    throwAt('T20'); throwAt('T20'); throwAt('T20');
    expect(heldBy(alice.id)).toContain('maximum');

    manager.apply({ type: 'UNDO' });
    // The 180 no longer exists in the log, so it must not survive as a fact.
    expect(heldBy(alice.id)).not.toContain('maximum');
  });

  it('re-awards it when the dart is thrown again', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    throwAt('T20'); throwAt('T20'); throwAt('T20');
    manager.apply({ type: 'UNDO' });
    expect(heldBy(alice.id)).not.toContain('maximum');

    throwAt('T20');
    expect(heldBy(alice.id)).toContain('maximum');
  });

  it('withdraws it when a correction invalidates it', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    throwAt('T20'); throwAt('T20'); throwAt('T20');
    expect(heldBy(alice.id)).toContain('maximum');

    // The board misread the first dart; it was really T19, so 179 not 180.
    const first = manager.view!.recent[0]!;
    manager.apply({ type: 'CORRECT_THROW', throwId: first.id, segment: seg('T19') });
    expect(heldBy(alice.id)).not.toContain('maximum');
  });

  it('does not withdraw an achievement earned in an earlier finished match', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    nineDartLeg();
    expect(heldBy(alice.id)).toContain('maximum');

    // A new match, where an undone dart must not touch history.
    manager.start(X01, [alice, bob]);
    throwAt('T20');
    manager.apply({ type: 'UNDO' });
    expect(heldBy(alice.id)).toContain('maximum');
  });

  it('keeps achievements from a match that was abandoned rather than finished', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    throwAt('T20'); throwAt('T20'); throwAt('T20');
    expect(heldBy(alice.id)).toContain('maximum');

    // Walk away mid-leg and start something else.
    manager.start(X01, [alice, bob]);
    store.recomputeAll();
    expect(heldBy(alice.id)).toContain('maximum');
  });

  it('cannot be farmed by throwing and undoing repeatedly', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    for (let i = 0; i < 3; i++) {
      throwAt('T20'); throwAt('T20'); throwAt('T20');
      expect(heldBy(alice.id)).toContain('maximum');
      manager.apply({ type: 'UNDO' });
      manager.apply({ type: 'UNDO' });
      manager.apply({ type: 'UNDO' });
      expect(heldBy(alice.id)).not.toContain('maximum');
    }
  });

  it('survives a rebuild triggered while the match is still being played', () => {
    const [alice, bob] = seedPlayers();
    // Some finished history first, so the rebuild has something to work from.
    manager.start(X01, [alice, bob]);
    nineDartLeg();

    manager.start(X01, [alice, bob]);
    throwAt('T20'); throwAt('T20'); throwAt('T20');
    expect(heldBy(alice.id)).toContain('maximum');

    // A rebuild only sees finished matches; the live match must not be lost.
    store.recomputeAll();
    manager.revalidateAchievements();
    expect(heldBy(alice.id)).toContain('maximum');
  });

  it('keeps the original unlock time rather than the most recent dart', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    throwAt('T20'); throwAt('T20'); throwAt('T20');
    const first = store.readAchievements(alice.id).find((a) => a.achievementId === 'maximum');
    throwAt('MISS'); throwAt('MISS'); throwAt('MISS');
    const later = store.readAchievements(alice.id).find((a) => a.achievementId === 'maximum');
    expect(later?.unlockedAt).toBe(first?.unlockedAt);
  });

  it('lets a full rebuild clear an unlock that the log no longer supports', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    nineDartLeg();
    expect(heldBy(alice.id)).toContain('nine-darter');

    // Rewrite history: the finishing dart was actually a single, not a double.
    const matchId = store.listMatches()[0]!.id;
    const log = store.commandsFor(matchId).filter((c) => c.type !== 'THROW' || true);
    const throws = log.filter((c) => c.type === 'THROW');
    const last = throws.at(-1)!;
    if (last.type === 'THROW') last.throw.segment = seg('T20');
    store.replaceCommands(matchId, log);

    store.recomputeAll();
    expect(heldBy(alice.id)).not.toContain('nine-darter');
  });
});

describe('deleting an achievement by hand', () => {
  it('removes it', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    nineDartLeg();
    expect(
      store.readAchievements(alice.id).find((a) => a.achievementId === 'maximum')?.unlockedAt,
    ).not.toBeNull();

    store.deleteAchievement(alice.id, 'maximum');
    expect(
      store.readAchievements(alice.id).find((a) => a.achievementId === 'maximum'),
    ).toBeUndefined();
  });

  it('lets it be earned again, because it is derived from the log', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    nineDartLeg();
    store.deleteAchievement(alice.id, 'maximum');

    // A rebuild re-derives it from the throws that are still in the log.
    store.recomputeAll();
    expect(
      store.readAchievements(alice.id).find((a) => a.achievementId === 'maximum')?.unlockedAt,
    ).not.toBeNull();
  });

  it('is made permanent by correcting the throw behind it', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    throwAt('T20'); throwAt('T20'); throwAt('T20');
    expect(heldBy(alice.id)).toContain('maximum');

    // The board misread the first dart. Fixing that is what actually removes it.
    const first = manager.view!.recent[0]!;
    manager.apply({ type: 'CORRECT_THROW', throwId: first.id, segment: seg('T19') });
    expect(heldBy(alice.id)).not.toContain('maximum');

    store.recomputeAll();
    manager.revalidateAchievements();
    expect(heldBy(alice.id)).not.toContain('maximum');
  });
});

describe('roster changes during a match', () => {
  it('adds a player mid-match and persists it in the log', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    throwAt('T20');

    const carol = toPlayer(store.createProfile('Carol'));
    manager.apply({ type: 'ADD_PLAYER', player: carol });

    expect(manager.view?.players).toHaveLength(3);
    const matchId = store.listMatches()[0]!.id;
    expect(store.commandsFor(matchId).some((c) => c.type === 'ADD_PLAYER')).toBe(true);
  });

  it('survives a restart with the roster change intact', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    const carol = toPlayer(store.createProfile('Carol'));
    manager.apply({ type: 'ADD_PLAYER', player: carol });
    throwAt('T20');

    const revived = new MatchManager(store, () => {});
    const view = revived.resume(store.findUnfinishedMatch()!);
    expect(view?.players.map((p) => p.name)).toEqual(['Alice', 'Bob', 'Carol']);
  });

  it('removes a player mid-match', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    manager.apply({ type: 'REMOVE_PLAYER', playerId: bob.id });
    expect(manager.view?.players.map((p) => p.name)).toEqual(['Alice']);
  });
});

describe('settings', () => {
  it('round-trips values', () => {
    expect(store.getSetting('coordsEnabled', false)).toBe(false);
    store.setSetting('coordsEnabled', true);
    expect(store.getSetting('coordsEnabled', false)).toBe(true);
    expect(store.allSettings()).toMatchObject({ coordsEnabled: true });
  });
});

describe('backfill', () => {
  it('rebuilds every projection from the command log alone', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    nineDartLeg();

    // Wipe the projections, keeping only matches, players and commands.
    db.exec('DELETE FROM throws; DELETE FROM stats_cache; DELETE FROM achievements;');
    expect(store.readAchievements(alice.id)).toHaveLength(0);

    const result = store.recomputeAll();
    expect(result.matches).toBe(1);

    const unlocked = store.readAchievements(alice.id).filter((a) => a.unlockedAt !== null);
    expect(unlocked.map((a) => a.achievementId)).toContain('nine-darter');
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM throws').get() as { n: number }).n,
    ).toBeGreaterThan(0);
  });

  it('gates coordinate-dependent achievements behind a flag', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    nineDartLeg();

    store.recomputeAll({ coordsEnabled: false });
    expect(store.readAchievements(alice.id).map((a) => a.achievementId)).not.toContain(
      'tight-grouping',
    );

    store.recomputeAll({ coordsEnabled: true });
    expect(store.readAchievements(alice.id).map((a) => a.achievementId)).toContain(
      'tight-grouping',
    );
  });
});

describe('ending a game early', () => {
  it('saves the match and awards it to whoever was closest to winning', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    throwAt('T20');
    throwAt('T20');
    throwAt('T20'); // Alice down to 321
    throwAt('S1');
    throwAt('S1');
    throwAt('S1'); // Bob still on 498

    manager.apply({ type: 'END_MATCH' });

    const summary = store.listMatches()[0];
    expect(summary?.endedAt).not.toBeNull();
    expect(summary?.winnerId).toBe(alice.id);
    expect(manager.view?.status).toBe('finished');
  });

  it('counts toward career statistics like any other finished match', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    throwAt('T20');
    manager.apply({ type: 'END_MATCH' });

    expect(store.careerFor(alice.id).matchesPlayed).toBe(1);
    expect(store.careerFor(alice.id).matchesWon).toBe(1);
  });
});

describe('the match report', () => {
  it('reports the match that was just played', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    nineDartLeg();

    const matchId = store.listMatches()[0]!.id;
    const report = store.summaryFor(matchId);
    expect(report?.winnerId).toBe(alice.id);
    expect(report?.totalDarts).toBe(15);
    const winner = report?.players.find((p) => p.playerId === alice.id);
    expect(winner?.average3).toBeCloseTo(167, 0);
    expect(winner?.count180).toBe(2);
    expect(winner?.checkouts[0]?.finisher).toBe('D12');
  });

  it('offers the winning turn so it can be replayed', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    nineDartLeg();

    const report = store.summaryFor(store.listMatches()[0]!.id);
    expect(report?.winningTurn?.playerId).toBe(alice.id);
    expect(report?.winningTurn?.darts.map((d) => d.label)).toEqual(['T20', 'T19', 'D12']);
  });

  it('resolves the most recently finished match for the "last game" button', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    nineDartLeg();

    const last = store.lastFinishedMatchId();
    expect(last).toBe(store.listMatches()[0]!.id);
    expect(store.summaryFor(last!)?.winnerId).toBe(alice.id);
  });

  it('hands back the settings of a past match so it can be played again', () => {
    const [alice, bob] = seedPlayers();
    manager.start({ ...X01, startScore: 301 }, [alice, bob]);
    throwAt('T20');
    manager.apply({ type: 'END_MATCH' });

    const setup = store.setupOf(store.lastFinishedMatchId()!);
    expect(setup?.gameType).toBe('x01');
    expect(setup?.playerIds).toEqual([alice.id, bob.id]);
    expect((setup?.config as { startScore: number }).startScore).toBe(301);
  });
});

describe('the heatmap', () => {
  it('counts segments even though no dart has coordinates', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    nineDartLeg();

    const map = store.heatmapFor(alice.id);
    expect(map.total).toBe(9);
    expect(map.byNumber[20]).toBe(7);
    expect(map.dots).toHaveLength(0);
    // Segment density is still the whole point, and it is fully populated.
    expect(map.cells.find((c) => c.number === 20 && c.ring === 'TRIPLE')?.count).toBe(7);
  });

  it('plots the darts whose source did report coordinates', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    throwAt('T20', { x: 4, y: 103 });
    throwAt('T20');
    throwAt('T20');
    manager.apply({ type: 'END_MATCH' });

    const map = store.heatmapFor(alice.id);
    expect(map.total).toBe(3);
    expect(map.withCoords).toBe(1);
    expect(map.dots[0]).toEqual({ x: 4, y: 103, playerId: alice.id });
  });
});

describe('golf', () => {
  const GOLF: GameConfig = {
    gameType: 'golf',
    holes: 2,
    par: 4,
    handicaps: {},
    legsToWin: 1,
    setsToWin: 1,
  };

  it('starts a newcomer on a handicap of 36', () => {
    const [alice] = seedPlayers();
    expect(store.golfHandicapFor(alice.id).handicap).toBe(36);
    expect(store.golfHandicapFor(alice.id).rounds).toBe(0);
  });

  it('moves the handicap once a round has been played', () => {
    const [alice] = seedPlayers();
    // Scratch, so par is a bare 4 a hole; holing out first dart each time.
    manager.start({ ...GOLF, handicaps: { [alice.id]: 0 } }, [alice]);
    throwAt('S1');
    throwAt('S2');
    expect(manager.view?.status).toBe('finished');

    // Two holes are judged against a par target of 4, and ten points off a
    // scratch handicap is far better than that -- so it floors at 0.
    const handicap = store.golfHandicapFor(alice.id);
    expect(handicap.rounds).toBe(1);
    expect(handicap.counted).toBe(1);
    expect(handicap.recent[0]?.parTarget).toBe(4);
    expect(handicap.handicap).toBe(0);
  });

  it('records the card in the match report', () => {
    const [alice] = seedPlayers();
    manager.start({ ...GOLF, handicaps: { [alice.id]: 0 } }, [alice]);
    throwAt('MISS');
    throwAt('S1'); // hole 1 in two: eagle
    throwAt('S2'); // hole 2 first dart: albatross

    const report = store.summaryFor(store.lastFinishedMatchId()!);
    expect(report?.players[0]?.golf?.points).toBe(9);
    expect(report?.players[0]?.golf?.holes.map((h) => h.strokes)).toEqual([2, 1]);
  });
});

/** Achievement ids announced to the UI for a player during this test. */
function unlockedIdsFor(playerId: string): string[] {
  return events
    .filter((e) => e.type === 'achievements.unlocked' && e.playerId === playerId)
    .flatMap((e) => (e.type === 'achievements.unlocked' ? e.achievements.map((a) => a.id) : []));
}

function toPlayer(p: { id: string; name: string; color: string }) {
  return { id: p.id, name: p.name, color: p.color };
}

function seedPlayers() {
  const alice = toPlayer(store.createProfile('Alice'));
  const bob = toPlayer(store.createProfile('Bob'));
  return [alice, bob] as const;
}
