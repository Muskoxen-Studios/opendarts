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
  roundLimit: null,
  legEnd: 'first',
  perPlayer: {},
};

let db: DatabaseSync;
let store: Store;
let events: ServerEvent[];
let manager: MatchManager;

/**
 * A turn that ends is held for takeout (BaseState.turnEnded) rather than
 * handing over immediately. `onBoardEvent` releases that hold at once for
 * non-board sources, since there is no physical takeout to wait for; this
 * helper calls `manager.apply` directly rather than going through
 * `onBoardEvent`, so it has to do the same thing itself.
 */
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
  if (manager.view?.awaitingTakeout) manager.apply({ type: 'ADVANCE_TURN' });
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

describe('holding the handover for a real takeout', () => {
  function boardThrow(label: string): void {
    const segment: Segment = seg(label);
    manager.onBoardEvent({
      type: 'throw.detected',
      throw: {
        id: `${label}-${Math.random()}`,
        ts: new Date().toISOString(),
        segment,
        value: segmentValue(segment),
        coords: null,
        source: 'board',
      },
    });
  }

  it('does not advance to the next player on the third dart', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    boardThrow('T20');
    boardThrow('T20');
    boardThrow('T20');

    expect(manager.view?.awaitingTakeout).toBe(true);
    expect(manager.view?.activePlayerId).toBe(alice.id);
    expect(manager.view?.turn.throws).toHaveLength(3);
  });

  it('advances only once takeout.completed arrives from the bridge', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    boardThrow('T20');
    boardThrow('T20');
    boardThrow('T20');

    manager.onBoardEvent({ type: 'takeout.completed' });

    expect(manager.view?.awaitingTakeout).toBe(false);
    expect(manager.view?.activePlayerId).toBe(bob.id);
    expect(manager.view?.turn.throws).toHaveLength(0);
  });

  it('ends a short turn too, when a dart missed the board and went undetected', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    boardThrow('T20');
    boardThrow('T20');
    // The third dart missed the board entirely, so it was never detected: the
    // engine still thinks a dart is owed and the turn is not held.
    expect(manager.view?.awaitingTakeout).toBe(false);

    events = [];
    manager.onBoardEvent({ type: 'takeout.completed' });

    expect(manager.view?.activePlayerId).toBe(bob.id);
    expect(manager.view?.turn.throws).toHaveLength(0);
    const completed = events
      .flatMap((e) => (e.type === 'domain' ? e.events : []))
      .find((e) => e.type === 'turn.completed');
    expect(completed).toMatchObject({ playerId: alice.id, darts: 2, busted: false });
  });

  it('ignores a takeout with nothing thrown, rather than skipping a player', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);

    manager.onBoardEvent({ type: 'takeout.completed' });

    expect(manager.view?.activePlayerId).toBe(alice.id);
    expect(bob).toBeDefined();
  });

  it('advances immediately for a simulated or manually-entered dart', () => {
    const [alice, bob] = seedPlayers();
    manager.start(X01, [alice, bob]);
    throwAt('T20');
    throwAt('T20');
    throwAt('T20');

    // throwAt already released the hold itself (source: 'simulator').
    expect(manager.view?.activePlayerId).toBe(bob.id);
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
    expect(store.getSetting('celebrations', true)).toBe(true);
    store.setSetting('celebrations', false);
    expect(store.getSetting('celebrations', true)).toBe(false);
    expect(store.allSettings()).toMatchObject({ celebrations: false });
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
    roundLimit: null,
  };

  it('starts a newcomer on a handicap of 36', () => {
    const [alice] = seedPlayers();
    expect(store.handicapFor(alice.id, 'golf').handicap).toBe(36);
    expect(store.handicapFor(alice.id, 'golf').rounds).toBe(0);
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
    const handicap = store.handicapFor(alice.id, 'golf');
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

describe('the leaderboard', () => {
  /** Alice beats Bob; both have a full match on record afterwards. */
  function aliceWins(): void {
    const players = store.listProfiles().map(toPlayer);
    manager.start(X01, players);
    nineDartLeg();
  }

  it('ranks on points: three for a win, one for turning up', () => {
    seedPlayers();
    aliceWins();

    const board = store.leaderboard();
    expect(board.rows.map((r) => r.name)).toEqual(['Alice', 'Bob']);
    expect(board.rows[0]).toMatchObject({ rank: 1, points: 3, matchesWon: 1, winRate: 1 });
    expect(board.rows[1]).toMatchObject({ rank: 2, points: 1, matchesWon: 0, winRate: 0 });
  });

  it('puts a regular loser above a one-match winner', () => {
    const [alice] = seedPlayers();
    aliceWins();
    aliceWins();
    aliceWins();
    aliceWins();

    // Bob has lost four; a newcomer wins their only match. Four appearances
    // (4 points) still outrank one win (3), which is the intended shape: the
    // table rewards playing, not a single lucky night.
    const carol = toPlayer(store.createProfile('Carol'));
    manager.start(X01, [carol]);
    nineDartLeg();

    const rows = store.leaderboard().rows;
    expect(rows.map((r) => r.name)).toEqual(['Alice', 'Bob', 'Carol']);
    expect(rows.find((r) => r.name === 'Bob')?.points).toBe(4);
    expect(rows.find((r) => r.name === 'Carol')?.points).toBe(3);
    expect(alice.id).toBe(rows[0]?.playerId);
  });

  it('carries the match statistics the table is read for', () => {
    seedPlayers();
    aliceWins();

    const alice = store.leaderboard().rows[0]!;
    expect(alice.average3).toBeCloseTo(167, 0);
    expect(alice.first9Average).toBeCloseTo(167, 0);
    expect(alice.bestTurn).toBe(180);
    expect(alice.count180).toBe(2);
    expect(alice.checkoutsHit).toBe(1);
    expect(alice.bustedTurns).toBe(0);
    // Built from segment counts, so it works with coords: null like everywhere else.
    expect(alice.heatmap.total).toBe(9);
    expect(alice.heatmap.byNumber[20]).toBe(7);
  });

  it('carries the best golf card, hole by hole', () => {
    const [alice] = seedPlayers();
    manager.start(
      { gameType: 'golf', holes: 2, par: 4, handicaps: { [alice.id]: 0 }, legsToWin: 1, setsToWin: 1, roundLimit: null },
      [alice],
    );
    throwAt('MISS');
    throwAt('S1');
    throwAt('S2');

    const row = store.leaderboard().rows.find((r) => r.playerId === alice.id)!;
    expect(row.golfRounds).toBe(1);
    expect(row.golfBestPoints).toBe(9);
    expect(row.golfBestCard?.map((h) => h.strokes)).toEqual([2, 1]);
  });

  it('drops a deleted player from the table without touching the matches', () => {
    const [alice] = seedPlayers();
    aliceWins();
    store.deleteProfile(alice.id);

    expect(store.leaderboard().rows.map((r) => r.name)).toEqual(['Bob']);
    // Bob's own record is unchanged: he still played, and still lost.
    expect(store.leaderboard().rows[0]).toMatchObject({ matchesPlayed: 1, matchesWon: 0 });
    // And the match itself is still on record, Alice included.
    expect(store.summaryFor(store.lastFinishedMatchId()!)?.players).toHaveLength(2);
  });
});

describe('resetting the leaderboard', () => {
  function aliceWins(): void {
    manager.start(X01, store.listProfiles().map(toPlayer));
    nineDartLeg();
  }

  it('archives the standings and starts the table empty', () => {
    seedPlayers();
    aliceWins();

    const archive = store.resetLeaderboard('Winter');
    expect(archive.label).toBe('Winter');
    expect(archive.matches).toBe(1);
    expect(archive.rows.map((r) => r.name)).toEqual(['Alice', 'Bob']);

    const fresh = store.leaderboard();
    expect(fresh.rows).toEqual([]);
    expect(fresh.matchesCounted).toBe(0);
    expect(fresh.since).toBe(archive.to);
  });

  it('deletes nothing: the log, career stats and match reports all survive', () => {
    const [alice] = seedPlayers();
    aliceWins();
    const matchId = store.lastFinishedMatchId()!;

    store.resetLeaderboard();

    // The command log is untouched, which is what everything else derives from.
    expect(store.commandsFor(matchId).length).toBeGreaterThan(0);
    expect(store.summaryFor(matchId)?.winnerId).toBe(alice.id);
    // A career is a career: it is not seasonal and does not reset.
    expect(store.careerFor(alice.id).matchesPlayed).toBe(1);
    expect(store.heatmapFor(alice.id).total).toBe(9);
  });

  it('counts matches played after the reset toward the new table', () => {
    seedPlayers();
    aliceWins();
    store.resetLeaderboard();
    aliceWins();

    const board = store.leaderboard();
    expect(board.matchesCounted).toBe(1);
    expect(board.rows[0]).toMatchObject({ name: 'Alice', matchesPlayed: 1, points: 3 });
  });

  it('keeps only the essential figures in an archive', () => {
    seedPlayers();
    aliceWins();
    const archive = store.resetLeaderboard();

    const row = archive.rows[0] as unknown as Record<string, unknown>;
    expect(row.average3).toBeDefined();
    expect(row.count180).toBe(2);
    // The bulky parts are left out on purpose: both are still derivable from
    // the command log, which the archive does not replace.
    expect(row.heatmap).toBeUndefined();
    expect(row.golfBestCard).toBeUndefined();
  });

  it('shows the handicap a golfer would actually play off, not a seasonal one', () => {
    const [alice] = seedPlayers();
    manager.start(
      { gameType: 'golf', holes: 2, par: 4, handicaps: { [alice.id]: 0 }, legsToWin: 1, setsToWin: 1, roundLimit: null },
      [alice],
    );
    throwAt('S1');
    throwAt('S2');
    const earned = store.handicapFor(alice.id, 'golf').handicap;

    // That round is now in the archive, so the new season knows nothing of it.
    store.resetLeaderboard();
    manager.start(X01, [alice]);
    nineDartLeg();

    const row = store.leaderboard().rows.find((r) => r.playerId === alice.id)!;
    expect(row.golfRounds).toBe(0);
    // The handicap still comes from every round ever played, because that is
    // the number the next round is played off.
    expect(row.golfHandicap).toBe(earned);
  });

  it('lists, reopens and discards archives', () => {
    seedPlayers();
    aliceWins();
    const first = store.resetLeaderboard('Spring');
    aliceWins();
    const second = store.resetLeaderboard('Summer');

    expect(store.listArchives().map((a) => a.label)).toEqual(['Summer', 'Spring']);
    expect(store.getArchive(first.id)?.rows).toHaveLength(2);

    expect(store.deleteArchive(second.id)).toBe(true);
    expect(store.listArchives().map((a) => a.label)).toEqual(['Spring']);
    expect(store.deleteArchive(second.id)).toBe(false);
  });

  it('labels an unnamed archive by the window it covered', () => {
    seedPlayers();
    aliceWins();
    const first = store.resetLeaderboard();
    // The first season has no start date, so it is named by its end.
    expect(first.label).toMatch(/^Up to /);
    expect(first.from).toBeNull();

    aliceWins();
    const second = store.resetLeaderboard();
    expect(second.from).toBe(first.to);
    expect(second.label).toContain('\u2013');
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
