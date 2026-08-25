import { Match } from '@darts/engine';
import {
  analyzeMatch,
  CATALOGUE,
  computeCareer,
  type MatchAnalysis,
  type MatchRecord,
} from '@darts/stats';
import type {
  BoardEvent,
  DomainEvent,
  GameConfig,
  MatchCommand,
  MatchView,
  Player,
} from '@darts/schema';
import type { Store } from './store.ts';

export type ServerEvent =
  | { type: 'view'; view: MatchView | null }
  | { type: 'domain'; events: DomainEvent[] }
  | { type: 'board'; event: BoardEvent }
  | {
      type: 'achievements.unlocked';
      playerId: string;
      playerName: string;
      achievements: Array<{
        id: string;
        name: string;
        description: string;
        icon: string;
        tier: string | null;
      }>;
    }
  | {
      /** An unlock the command log no longer supports, after an undo or correction. */
      type: 'achievements.withdrawn';
      playerId: string;
      playerName: string;
      achievementIds: string[];
    };

export class MatchManager {
  private store: Store;
  private broadcast: (e: ServerEvent) => void;
  private match: Match | null = null;
  private matchId: string | null = null;
  /** Latest board status, surfaced to the UI as a connection indicator. */
  private boardOnline = false;

  /**
   * Analyses of every finished match, cached so live achievement checks after
   * each dart do not re-read and re-replay the whole history from SQLite.
   */
  private finishedAnalyses: MatchAnalysis[] = [];
  /** Achievements already announced during the current match, per player. */
  private announced = new Map<string, Set<string>>();
  /**
   * Achievements each player already held when this match started.
   *
   * Anything in here was earned by earlier, finished matches, so undoing a dart
   * in the current match must never take it away.
   */
  private heldAtMatchStart = new Map<string, Set<string>>();

  constructor(store: Store, broadcast: (e: ServerEvent) => void) {
    this.store = store;
    this.broadcast = broadcast;
    this.refreshHistory();
  }

  /**
   * Re-apply the live match's achievements after a rebuild.
   *
   * A rebuild recomputes from finished matches only, so it does not know about
   * the match currently being played. Without this, pressing "rebuild" mid-leg
   * would clear an achievement that was legitimately earned minutes earlier.
   */
  revalidateAchievements(): void {
    this.heldAtMatchStart.clear();
    if (!this.match) return;
    for (const p of this.match.view.players) this.snapshotHeld(p.playerId);
    this.checkLiveAchievements();
  }

  /**
   * Forget that an achievement was announced this match, so it can be awarded
   * -- and celebrated -- again. Used after a player deletes one by hand.
   */
  forgetAnnounced(playerId: string, achievementId: string): void {
    this.announced.get(playerId)?.delete(achievementId);
  }

  private refreshHistory(): void {
    this.finishedAnalyses = this.store.loadFinishedMatches().map(analyzeMatch);
  }

  /** Record what a player already held, so this match can only add to it. */
  private snapshotHeld(playerId: string): Set<string> {
    const existing = this.heldAtMatchStart.get(playerId);
    if (existing) return existing;
    const held = new Set(
      this.store
        .readAchievements(playerId)
        .filter((a) => a.unlockedAt !== null)
        .map((a) => a.achievementId),
    );
    this.heldAtMatchStart.set(playerId, held);
    return held;
  }

  get view(): MatchView | null {
    return this.match?.view ?? null;
  }

  get isBoardOnline(): boolean {
    return this.boardOnline;
  }

  start(config: GameConfig, players: Player[]): MatchView {
    // Close anything still open. Unlock state is derived from finished matches,
    // so an abandoned match left open would have its achievements wiped by the
    // next rebuild -- it counts as played, with no winner.
    this.abandonCurrent();

    const id = this.store.createMatch(config.gameType, config, players);
    this.matchId = id;
    this.match = new Match(id, players, config);
    this.announced.clear();
    this.heldAtMatchStart.clear();
    for (const p of players) this.snapshotHeld(p.id);
    this.apply({ type: 'START' });
    return this.match.view;
  }

  /** Close an unfinished match so its history still counts. */
  private abandonCurrent(): void {
    if (this.matchId && this.match && !this.match.finished) {
      this.store.finishMatch(this.matchId, null);
      this.refreshHistory();
    }
  }

  /** Restore an interrupted match from its persisted command log. */
  resume(matchId: string): MatchView | null {
    const record = this.store.loadMatchRecord(matchId);
    if (!record) return null;
    this.matchId = matchId;
    this.match = Match.fromLog(matchId, record.players, record.config, record.commands);
    this.announced.clear();
    this.heldAtMatchStart.clear();
    for (const p of this.match.view.players) this.snapshotHeld(p.playerId);
    this.broadcast({ type: 'view', view: this.match.view });
    return this.match.view;
  }

  apply(cmd: MatchCommand): MatchView | null {
    if (!this.match || !this.matchId) return null;

    const wasFinished = this.match.finished;
    const events = this.match.apply(cmd);

    // Persist the whole log: undo and correction edit history rather than
    // appending, so an incremental append would drift from the real state.
    this.store.replaceCommands(this.matchId, this.match.log);

    if (events.length > 0) this.broadcast({ type: 'domain', events });
    this.broadcast({ type: 'view', view: this.match.view });

    // Check achievements after every command so an unlock is celebrated the
    // moment it happens, rather than being held back until the match ends.
    this.checkLiveAchievements();

    if (!wasFinished && this.match.finished) this.finalize();
    return this.match.view;
  }

  /** A record for the match as it currently stands, for mid-match analysis. */
  private liveRecord(): MatchRecord | null {
    if (!this.match || !this.matchId) return null;
    return {
      matchId: this.matchId,
      gameType: this.match.config.gameType,
      config: this.match.config,
      // The initial roster: any later joins and departures are in the log.
      players: this.match.players,
      commands: [...this.match.log],
      endedAt: null,
    };
  }

  /**
   * Reconcile achievements against the match as it currently stands.
   *
   * This runs after every command and works in BOTH directions. An unlock is a
   * projection of the command log, so when a dart is undone or corrected and
   * the achievement is no longer earned, it has to be withdrawn again --
   * otherwise undo would leave a permanent reward behind, and players could
   * farm achievements by throwing and undoing.
   *
   * Achievements held before this match started are never touched.
   */
  private checkLiveAchievements(): void {
    const record = this.liveRecord();
    if (!record || !this.match) return;

    const analysis = analyzeMatch(record);
    const history = [...this.finishedAnalyses, analysis];

    for (const player of this.match.view.players) {
      const id = player.playerId;
      const held = this.snapshotHeld(id);
      const seen = this.announced.get(id) ?? new Set<string>();
      const current = new Map(this.store.readAchievements(id).map((a) => [a.achievementId, a]));
      const career = computeCareer(id, history);
      const now = new Date().toISOString();

      const earned = new Set<string>();
      const celebrate: Array<{
        id: string;
        name: string;
        description: string;
        icon: string;
        tier: string | null;
      }> = [];
      /** Rows this match owns: unlock state is ours to set, either way. */
      const unlockRows: Array<{
        achievementId: string;
        unlockedAt: string | null;
        progress: number;
        goal: number;
      }> = [];
      /** Rows held from earlier matches: progress only, never unlock state. */
      const progressRows: Array<{ achievementId: string; progress: number; goal: number }> = [];

      for (const achievement of CATALOGUE) {
        const result = achievement.evaluate({ playerId: id, match: analysis, career });
        const progress = result.progress ?? (result.unlocked ? 1 : 0);
        const goal = result.goal ?? achievement.goal ?? 1;

        // Held before this match started: not ours to award or take away.
        if (held.has(achievement.id)) {
          progressRows.push({ achievementId: achievement.id, progress, goal });
          continue;
        }

        if (result.unlocked) {
          earned.add(achievement.id);
          unlockRows.push({
            achievementId: achievement.id,
            // Keep the moment it was first earned, not the latest dart.
            unlockedAt: current.get(achievement.id)?.unlockedAt ?? now,
            progress,
            goal,
          });
          if (!seen.has(achievement.id)) {
            celebrate.push({
              id: achievement.id,
              name: achievement.name,
              description: achievement.description,
              icon: achievement.icon,
              tier: achievement.tier ?? null,
            });
          }
        } else {
          // Explicitly not earned. Writing the row keeps progress bars moving
          // during the match, and withdraws anything an undo invalidated.
          unlockRows.push({ achievementId: achievement.id, unlockedAt: null, progress, goal });
        }
      }

      // Awarded during this match but no longer supported by the log.
      const withdrawn = [...seen].filter((a) => !earned.has(a));
      for (const achievementId of withdrawn) seen.delete(achievementId);
      for (const a of celebrate) seen.add(a.id);
      this.announced.set(id, seen);

      if (unlockRows.length > 0) this.store.writeAchievements(id, unlockRows);
      if (progressRows.length > 0) this.store.writeProgress(id, progressRows);

      if (celebrate.length > 0) {
        this.broadcast({
          type: 'achievements.unlocked',
          playerId: id,
          playerName: player.name,
          achievements: celebrate,
        });
      }

      if (withdrawn.length > 0) {
        this.broadcast({
          type: 'achievements.withdrawn',
          playerId: id,
          playerName: player.name,
          achievementIds: withdrawn,
        });
      }
    }
  }

  onBoardEvent(event: BoardEvent): void {
    switch (event.type) {
      case 'board.connected':
      case 'board.heartbeat':
        this.boardOnline = true;
        break;
      case 'board.disconnected':
        this.boardOnline = false;
        break;
      case 'throw.detected': {
        this.broadcast({ type: 'board', event });
        const view = this.apply({ type: 'THROW', throw: event.throw });
        // A real board holds the finished turn until the darts are physically
        // pulled out (see BaseState.turnEnded), so players get a moment to
        // check the detection was right before the highlight moves on. The
        // simulator and manual entry have no physical takeout to wait for, so
        // release the hold at once -- same as today's instant handover.
        if (view?.awaitingTakeout && event.throw.source !== 'board') {
          this.apply({ type: 'ADVANCE_TURN' });
        }
        return;
      }
      case 'takeout.completed': {
        // A takeout is physical proof the turn is over. Usually the turn is
        // already held (`awaitingTakeout`) and this just releases it -- but a
        // dart that misses the board entirely is never detected, so the engine
        // still thinks darts are owed and ADVANCE_TURN would be a no-op,
        // stranding the turn until someone pressed "End turn". End it instead.
        const view = this.view;
        if (view?.awaitingTakeout) {
          this.apply({ type: 'ADVANCE_TURN' });
        } else if (view?.status === 'playing' && view.turn.throws.length > 0) {
          this.apply({ type: 'NEXT_PLAYER' });
        }
        // With nothing thrown there is no turn to end: a stray takeout at a
        // fresh oche must not skip a player.
        this.broadcast({ type: 'board', event });
        return;
      }
      default:
        break;
    }
    this.broadcast({ type: 'board', event });
  }

  /**
   * Roll a finished match into the durable projections.
   *
   * Achievements are diffed before and after so genuinely new unlocks can be
   * announced, rather than re-announcing everything the player already had.
   */
  private finalize(): void {
    if (!this.match || !this.matchId) return;
    const view = this.match.view;
    const roster = view.players.map((p) => ({ id: p.playerId, name: p.name }));

    const before = new Map<string, Set<string>>();
    for (const p of roster) {
      before.set(
        p.id,
        new Set(
          this.store
            .readAchievements(p.id)
            .filter((a) => a.unlockedAt !== null)
            .map((a) => a.achievementId),
        ),
      );
    }

    this.store.finishMatch(this.matchId, view.winnerId);
    this.store.recomputeAll();
    this.refreshHistory();

    for (const p of roster) {
      const now = this.store
        .readAchievements(p.id)
        .filter((a) => a.unlockedAt !== null)
        .map((a) => a.achievementId);
      const prior = before.get(p.id) ?? new Set<string>();
      const seen = this.announced.get(p.id) ?? new Set<string>();
      // Anything already celebrated mid-match is not announced a second time.
      const fresh = now.filter((id) => !prior.has(id) && !seen.has(id));
      if (fresh.length === 0) continue;

      const details = fresh
        .map((id) => CATALOGUE.find((a) => a.id === id))
        .filter((a) => a !== undefined)
        .map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          icon: a.icon,
          tier: a.tier ?? null,
        }));

      this.broadcast({
        type: 'achievements.unlocked',
        playerId: p.id,
        playerName: p.name,
        achievements: details,
      });
    }
  }
}
