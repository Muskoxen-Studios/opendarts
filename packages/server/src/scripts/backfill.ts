/**
 * Re-evaluate every statistic and achievement against the full command log.
 *
 * Run this after adding a new achievement so it unlocks retroactively, or after
 * fixing a statistic's definition so history is corrected too. Run with:
 *   npm run achievements:backfill
 */
import { openDatabase } from '../db.ts';
import { Store } from '../store.ts';

const DB_FILE = process.env.DB_FILE ?? 'data/darts.db';
const db = openDatabase(DB_FILE);
const store = new Store(db);

console.log(`Backfilling from ${DB_FILE}...`);
const started = Date.now();
const result = store.recomputeAll();
const seconds = ((Date.now() - started) / 1000).toFixed(2);

console.log(
  `Rebuilt projections for ${result.matches} matches and ${result.profiles} profiles ` +
    `in ${seconds}s. ${result.unlocked} achievement unlocks recorded.`,
);
db.close();
