/**
 * The game manuals.
 *
 * One markdown file per game in `manuals/`, named after its `GameType`, pulled
 * in at build time as raw text -- so a manual is edited as a plain document and
 * nothing has to be wired up beyond dropping the file in. An empty or missing
 * file is a legitimate state: the manual button says so rather than breaking.
 */

const files = import.meta.glob('./manuals/*.md', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

const manuals: Record<string, string> = {};
for (const [path, text] of Object.entries(files)) {
  const name = path.slice(path.lastIndexOf('/') + 1, -'.md'.length);
  manuals[name] = text;
}

/** The manual for a game, or `null` when there is no text for it yet. */
export function manualFor(gameType: string): string | null {
  const text = manuals[gameType];
  return text && text.trim() !== '' ? text : null;
}
