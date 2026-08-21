# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`README.md` is the long-form document: game rules, feature behaviour, and the reasoning behind
most design decisions. Read the relevant section there before changing user-facing behaviour.
This file covers what the README does not: how to work in the tree.

## Commands

```bash
npm run check              # typecheck (tsc + vue-tsc) and tests -- the whole CI gate
npm test                   # vitest run
npm run test:watch
npx vitest run packages/engine/src/x01.test.ts          # single file
npx vitest run packages/engine/src -t "bust"            # single test by name
npm run typecheck          # backend tsc --noEmit + frontend vue-tsc --noEmit
```

Dev, three terminals (or `npm run dev:desktop` for one Electron window that starts both backends):

```bash
npm run dev:bridge         # :8081
npm run dev:server         # :8080
npm run dev:frontend       # :5173, proxies /api and /ws to :8080
npm run dev:fakeboard      # :3180, only needed for SOURCE=autodarts without hardware
```

`npm run build` builds only the frontend. **The backend has no build step** — Node 24 runs the
`.ts` sources directly by type stripping, so `tsc` is used purely as a checker (`noEmit`,
`erasableSyntaxOnly`). That means: no enums, no parameter properties, no namespaces, and imports
must carry the `.ts` extension (`import { x } from './y.ts'`).

Other entry points: `npm run achievements:backfill` after adding an achievement,
`npm run package` to stage and build a desktop installer into `build/release`.
`npm run release -- patch|minor|major|x.y.z` bumps every workspace to one version, commits, tags
`vX.Y.Z` and pushes it -- the tag is what triggers the installer build in `release.yml`. Add
`--dry-run` to see the plan, `--no-push` to stop after the local tag.

## Architecture

```
Board Manager -> @darts/bridge -> @darts/server -> @darts/frontend
                 normalises to    game logic +     Vue 3 scoreboard
                 our schema       SQLite
```

Dependency direction is strictly one way: `schema <- engine <- stats <- server`. Nothing imports
the bridge; the server reaches it over websocket (`BRIDGE_WS`) and HTTP (`BRIDGE_HTTP`). The
frontend depends on `@darts/schema` and nothing else — stats types are deliberately re-declared
in [store.ts](packages/frontend/src/store.ts) rather than imported, to keep the engine out of the
browser bundle.

**The command log is the source of truth.** Every command is appended to the `commands` table;
match state, career stats and achievement progress are projections folded from it. Undo and
correction edit the log and re-fold from the start of the leg — engines therefore only ever move
forward and never unwind. Consequences worth keeping in mind: new achievements backfill over all
history, stat definitions are fixable retroactively, and achievements must be reconciled in both
directions (an undo withdraws what it earned).

**The anti-corruption boundary.** [autodarts.ts](packages/bridge/src/adapters/autodarts.ts) is the
only file that may know Autodarts field *names*; [boardControl.ts](packages/bridge/src/boardControl.ts)
is the only one that knows its control *paths*. Everything else speaks `@darts/schema`. The adapter
parses strictly and fails loudly — a silent mis-parse would corrupt career statistics plausibly.

**`coords` is nullable and nothing may depend on it.** Engines, stats, scoring and the scoreboard
must all be correct with `coords: null`; only visualisations read it, and they degrade. The engine
testkit's `dart()` returns `coords: null` on purpose. Coordinates are normalised by 170, origin at
the bull, **x right and y up** — the round-trip test in `adapters/autodarts.test.ts` asserts every
segment plots back inside its own wedge *by angle*, because a radius cannot confirm an axis
direction (this bug shipped once).

### Packages

| Package | Notes |
|---|---|
| `@darts/schema` | Zod schemas + types; the isolation boundary. |
| `@darts/engine` | Pure game logic, no I/O. One file per game + one line in `registry.ts`. |
| `@darts/stats` | Projections: career, leaderboard, golf handicap, achievements. |
| `@darts/bridge` | Board adapter and the `simulator` / `autodarts` / `replay` sources. |
| `@darts/fakeboard` | Stand-in Board Manager on :3180; control endpoints live under `/sim`, never `/api`. |
| `@darts/server` | Hand-rolled router in `main.ts`, `MatchManager`, `Store`, WS at `/ws`. |
| `@darts/frontend` | Vue 3, single reactive store in `store.ts`, no router and no Pinia. |

### Adding a game

One file in `packages/engine/src/`, implementing `GameEngine` from
[types.ts](packages/engine/src/types.ts) (`parseConfig` / `createInitialState` / `reduce` / `view`),
plus one entry in [registry.ts](packages/engine/src/registry.ts). Engines handle only
`ForwardCommand`s — `UNDO` and `CORRECT_THROW` are the `Match` wrapper's job. Every cast from the
erased `unknown` state lives in `match.ts` and nowhere else. Use `seg()`, `dart()` and `throwCmd()`
from [testkit.ts](packages/engine/src/testkit.ts) in tests; the engine must also decide who is
"closest to winning" for `END_MATCH`.

### Configuration

`.env` (see `.env.example`) — `SOURCE` (`simulator` | `autodarts` | `replay`), `BOARD_URL`,
`REPLAY_FILE`, `WEB_PORT`. Simulated darts are POSTed to the *bridge*, not into the server, so
they travel the same path a real dart does. Server env: `PORT`, `HOST`, `DB_FILE`
(default `data/darts.db`), `WEB_ROOT`, `BRIDGE_WS`, `BRIDGE_HTTP`.

Persistence is `node:sqlite` (built into Node — no native module). Schema and lightweight
migrations live in [db.ts](packages/server/src/db.ts).

### recon/

Captures and `FINDINGS.md` documenting the real Board Manager's local protocol — transport, control
API, throw payload and coordinate frame, all now marked CONFIRMED against hardware. The fakeboard
emits that payload shape, so a green fakeboard test proves the bridge handles it; the protocol claim
itself rests on `FINDINGS.md`, not on the fake.
