import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  analyzeMatch,
  backfillPlayer,
  buildHeatmap,
  computeCareer,
  computeGolfHandicap,
  summarizeMatch,
  type CareerStats,
  type GolfHandicap,
  type Heatmap,
  type MatchAnalysis,
  type MatchRecord,
  type MatchReport,
} from '@darts/stats';
import type { GameConfig, GameType, MatchCommand, Player } from '@darts/schema';

export interface Profile {
  id: string;
  name: string;
  color: string;
  avatar: string | null;
  createdAt: string;
}

export interface MatchSummary {
  id: string;
  gameType: GameType;
  startedAt: string;
  endedAt: string | null;
  winnerId: string | null;
  players: Player[];
}

export class Store {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // -- profiles -------------------------------------------------------------

  listProfiles(): Profile[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, color, avatar, created_at FROM profiles
         WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(toProfile);
  }

  getProfile(id: string): Profile | null {
    const row = this.db
      .prepare(`SELECT id, name, color, avatar, created_at FROM profiles WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? toProfile(row) : null;
  }

  createProfile(name: string, color = '#4f8ef7', avatar: string | null = null): Profile {
    const profile: Profile = {
      id: randomUUID(),
      name,
      color,
      avatar,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO profiles (id, name, color, avatar, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(profile.id, profile.name, profile.color, profile.avatar, profile.createdAt);
    return profile;
  }

  updateProfile(id: string, patch: Partial<Pick<Profile, 'name' | 'color' | 'avatar'>>): Profile | null {
    const existing = this.getProfile(id);
    if (!existing) return null;
    const next = { ...existing, ...patch };
    this.db
      .prepare(`UPDATE profiles SET name = ?, color = ?, avatar = ? WHERE id = ?`)
      .run(next.name, next.color, next.avatar, id);
    return next;
  }

  /** Soft delete, so the profile's matches and statistics stay intact. */
  deleteProfile(id: string): boolean {
    const res = this.db
      .prepare(`UPDATE profiles SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(new Date().toISOString(), id);
    return Number(res.changes) > 0;
  }

  // -- matches --------------------------------------------------------------

  createMatch(gameType: GameType, config: GameConfig, players: Player[]): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO matches (id, game_type, config_json, started_at) VALUES (?, ?, ?, ?)`,
      )
      .run(id, gameType, JSON.stringify(config), now);

    const insert = this.db.prepare(
      `INSERT INTO match_players (match_id, profile_id, seat) VALUES (?, ?, ?)`,
    );
    players.forEach((p, seat) => insert.run(id, p.id, seat));
    return id;
  }

  appendCommand(matchId: string, seq: number, cmd: MatchCommand): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO commands (match_id, seq, ts, type, payload_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(matchId, seq, new Date().toISOString(), cmd.type, JSON.stringify(cmd));
  }

  /**
   * Replace the whole command log for a match.
   *
   * Undo and correction edit the log rather than appending to it, so the
   * persisted log always reflects the corrected history -- which is what makes
   * statistics and achievements recomputable.
   */
  replaceCommands(matchId: string, commands: readonly MatchCommand[]): void {
    this.db.prepare(`DELETE FROM commands WHERE match_id = ?`).run(matchId);
    const insert = this.db.prepare(
      `INSERT INTO commands (match_id, seq, ts, type, payload_json) VALUES (?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    commands.forEach((cmd, seq) => insert.run(matchId, seq, now, cmd.type, JSON.stringify(cmd)));
  }

  finishMatch(matchId: string, winnerId: string | null): void {
    this.db
      .prepare(`UPDATE matches SET ended_at = ?, winner_id = ? WHERE id = ?`)
      .run(new Date().toISOString(), winnerId, matchId);
  }

  loadMatchRecord(matchId: string): MatchRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, game_type, config_json, started_at, ended_at FROM matches WHERE id = ?`,
      )
      .get(matchId) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      matchId,
      gameType: String(row.game_type) as GameType,
      config: JSON.parse(String(row.config_json)) as GameConfig,
      players: this.playersFor(matchId),
      commands: this.commandsFor(matchId),
      endedAt: row.ended_at ? String(row.ended_at) : null,
      startedAt: row.started_at ? String(row.started_at) : null,
    };
  }

  /** Every finished match, oldest first. Chronological order matters for streaks. */
  loadFinishedMatches(): MatchRecord[] {
    const rows = this.db
      .prepare(`SELECT id FROM matches WHERE ended_at IS NOT NULL ORDER BY ended_at ASC`)
      .all() as Array<Record<string, unknown>>;
    const out: MatchRecord[] = [];
    for (const row of rows) {
      const rec = this.loadMatchRecord(String(row.id));
      if (rec) out.push(rec);
    }
    return out;
  }

  listMatches(limit = 50): MatchSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, game_type, started_at, ended_at, winner_id FROM matches
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      gameType: String(row.game_type) as GameType,
      startedAt: String(row.started_at),
      endedAt: row.ended_at ? String(row.ended_at) : null,
      winnerId: row.winner_id ? String(row.winner_id) : null,
      players: this.playersFor(String(row.id)),
    }));
  }

  playersFor(matchId: string): Player[] {
    const rows = this.db
      .prepare(
        `SELECT mp.profile_id, mp.seat, p.name, p.color
         FROM match_players mp LEFT JOIN profiles p ON p.id = mp.profile_id
         WHERE mp.match_id = ? ORDER BY mp.seat`,
      )
      .all(matchId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.profile_id),
      name: r.name ? String(r.name) : 'Unknown',
      color: r.color ? String(r.color) : '#888888',
    }));
  }

  commandsFor(matchId: string): MatchCommand[] {
    const rows = this.db
      .prepare(`SELECT payload_json FROM commands WHERE match_id = ? ORDER BY seq ASC`)
      .all(matchId) as Array<Record<string, unknown>>;
    return rows.map((r) => JSON.parse(String(r.payload_json)) as MatchCommand);
  }

  /** A match that was interrupted, so play can resume after a restart. */
  findUnfinishedMatch(): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM matches WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    return row ? String(row.id) : null;
  }

  // -- projections ----------------------------------------------------------

  /** Rewrite the throws projection for one match from its analysis. */
  writeThrows(matchId: string, analysis: MatchAnalysis): void {
    this.db.prepare(`DELETE FROM throws WHERE match_id = ?`).run(matchId);
    const insert = this.db.prepare(
      `INSERT INTO throws
       (id, match_id, profile_id, leg, dart_no, segment_number, segment_ring, value, counted, coords_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    analysis.throws.forEach((t, i) => {
      insert.run(
        `${matchId}:${i}`,
        matchId,
        t.playerId,
        t.leg,
        i,
        t.number,
        t.ring,
        t.value,
        t.counted,
        // Written when the source reported them and null otherwise, which is
        // still the normal case for board throws. Nothing may depend on it.
        t.coords ? JSON.stringify(t.coords) : null,
      );
    });
  }

  writeCareer(profileId: string, stats: CareerStats): void {
    const insert = this.db.prepare(
      `INSERT INTO stats_cache (profile_id, metric, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, metric) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    const now = new Date().toISOString();
    for (const [metric, value] of Object.entries(stats)) {
      if (typeof value === 'number') insert.run(profileId, metric, value, now);
      else if (value === null) insert.run(profileId, metric, null, now);
    }
  }

  writeAchievements(
    profileId: string,
    entries: Array<{ achievementId: string; unlockedAt: string | null; progress: number; goal: number }>,
  ): void {
    // The incoming value is authoritative. It must NOT be merged with what is
    // already stored: unlock state is a projection of the command log, so if a
    // rebuild says an achievement is no longer earned -- because the throws
    // behind it were undone or corrected -- it has to go. Merging would make
    // the row sticky and place it permanently beyond the reach of a rebuild.
    const insert = this.db.prepare(
      `INSERT INTO achievements (profile_id, achievement_id, unlocked_at, progress, goal)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, achievement_id) DO UPDATE SET
         unlocked_at = excluded.unlocked_at,
         progress = excluded.progress,
         goal = excluded.goal`,
    );
    for (const e of entries) {
      insert.run(profileId, e.achievementId, e.unlockedAt, e.progress, e.goal);
    }
  }

  readAchievements(profileId: string): Array<{
    achievementId: string;
    unlockedAt: string | null;
    progress: number;
    goal: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT achievement_id, unlocked_at, progress, goal
         FROM achievements WHERE profile_id = ?`,
      )
      .all(profileId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      achievementId: String(r.achievement_id),
      unlockedAt: r.unlocked_at ? String(r.unlocked_at) : null,
      progress: Number(r.progress),
      goal: Number(r.goal),
    }));
  }

  /**
   * Update progress without touching unlock state.
   *
   * Used for achievements a player already held before the current match: their
   * bars should keep moving, but the match in progress must not be able to
   * revoke something earned earlier.
   */
  writeProgress(
    profileId: string,
    rows: Array<{ achievementId: string; progress: number; goal: number }>,
  ): void {
    const update = this.db.prepare(
      `INSERT INTO achievements (profile_id, achievement_id, unlocked_at, progress, goal)
       VALUES (?, ?, NULL, ?, ?)
       ON CONFLICT(profile_id, achievement_id) DO UPDATE SET
         progress = excluded.progress,
         goal = excluded.goal`,
    );
    for (const r of rows) update.run(profileId, r.achievementId, r.progress, r.goal);
  }

  /**
   * Remove an achievement outright.
   *
   * Used both when a player deletes one by hand and when an undo means the
   * command log no longer supports it. There is deliberately no "stays
   * removed" flag: an achievement is a projection of the log, so if it is
   * still earned it will simply be awarded again.
   */
  deleteAchievement(profileId: string, achievementId: string): void {
    this.db
      .prepare(`DELETE FROM achievements WHERE profile_id = ? AND achievement_id = ?`)
      .run(profileId, achievementId);
  }

  // -- derived views --------------------------------------------------------

  /** Everything the post-match overview shows, for any match on record. */
  summaryFor(matchId: string): MatchReport | null {
    const record = this.loadMatchRecord(matchId);
    if (!record) return null;
    return summarizeMatch(analyzeMatch(record));
  }

  /** The most recently finished match, which is what "last game" means. */
  lastFinishedMatchId(): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM matches WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    return row ? String(row.id) : null;
  }

  /** The config and roster of a past match, ready to be started again. */
  setupOf(matchId: string): { config: GameConfig; playerIds: string[]; gameType: GameType } | null {
    const row = this.db
      .prepare(`SELECT game_type, config_json FROM matches WHERE id = ?`)
      .get(matchId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      gameType: String(row.game_type) as GameType,
      config: JSON.parse(String(row.config_json)) as GameConfig,
      playerIds: this.playersFor(matchId).map((p) => p.id),
    };
  }

  /**
   * Where one player's darts have landed across every finished match.
   *
   * Read from the `throws` projection rather than by replaying command logs:
   * this is exactly the query that table exists for, and a career of darts is
   * far too many to re-fold on every page view.
   */
  heatmapFor(profileId: string): Heatmap {
    const rows = this.db
      .prepare(
        `SELECT profile_id, segment_number, segment_ring, coords_json
         FROM throws WHERE profile_id = ?`,
      )
      .all(profileId) as Array<Record<string, unknown>>;
    return buildHeatmap(
      rows.map((r) => ({
        playerId: String(r.profile_id),
        number: Number(r.segment_number),
        ring: String(r.segment_ring),
        coords: r.coords_json
          ? (JSON.parse(String(r.coords_json)) as { x: number; y: number })
          : null,
      })),
    );
  }

  /** The Stableford handicap this player carries into their next round. */
  golfHandicapFor(profileId: string): GolfHandicap {
    return computeGolfHandicap(profileId, this.loadFinishedMatches().map(analyzeMatch));
  }

  // -- settings -------------------------------------------------------------

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare(`SELECT value_json FROM settings WHERE key = ?`)
      .get(key) as Record<string, unknown> | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(String(row.value_json)) as T;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  allSettings(): Record<string, unknown> {
    const rows = this.db.prepare(`SELECT key, value_json FROM settings`).all() as Array<
      Record<string, unknown>
    >;
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[String(r.key)] = JSON.parse(String(r.value_json));
      } catch {
        // Ignore an unreadable value rather than failing the whole request.
      }
    }
    return out;
  }

  /**
   * Drop and rebuild every projection from the command log.
   *
   * This is the backfill path: it is what makes a newly added achievement
   * unlock retroactively, and what lets a corrected statistic definition be
   * applied to history rather than only to future matches.
   */
  recomputeAll(opts: { coordsEnabled?: boolean } = {}): {
    matches: number;
    profiles: number;
    unlocked: number;
  } {
    const records = this.loadFinishedMatches();
    const analyses = records.map(analyzeMatch);

    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const analysis = analyses[i];
      if (rec && analysis) this.writeThrows(rec.matchId, analysis);
    }

    const profileIds = new Set<string>();
    for (const rec of records) for (const p of rec.players) profileIds.add(p.id);

    let unlocked = 0;
    for (const profileId of profileIds) {
      this.writeCareer(profileId, computeCareer(profileId, analyses));
      const entries = backfillPlayer(profileId, analyses, {
        coordsEnabled: opts.coordsEnabled ?? false,
      });
      this.writeAchievements(profileId, entries);
      unlocked += entries.filter((e) => e.unlockedAt !== null).length;
    }

    return { matches: records.length, profiles: profileIds.size, unlocked };
  }

  careerFor(profileId: string): CareerStats {
    const analyses = this.loadFinishedMatches().map(analyzeMatch);
    return computeCareer(profileId, analyses);
  }
}

function toProfile(row: Record<string, unknown>): Profile {
  return {
    id: String(row.id),
    name: String(row.name),
    color: String(row.color),
    avatar: row.avatar ? String(row.avatar) : null,
    createdAt: String(row.created_at),
  };
}
