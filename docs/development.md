# Development and releases

For installation, features and game modes, see the [README](../README.md).

## Architecture

```
Board Manager  ->  bridge  ->  server  ->  frontend
 (unchanged)      normalises   game logic   scoreboard
                  to our own   + SQLite     (Vue 3)
                  event schema
```

| Package | Role |
|---|---|
| `@darts/schema` | Our event, command and view types. The isolation boundary. |
| `@darts/engine` | Pure game logic for all nine game modes. No I/O. |
| `@darts/stats` | Statistics and achievements, computed as projections. |
| `@darts/bridge` | Autodarts adapter, plus simulator, native detector and replay sources. |
| `@darts/fakeboard` | A stand-in Board Manager, for testing without hardware. |
| `@darts/server` | Match state, profiles, persistence, WS + REST API. |
| `@darts/frontend` | Vue 3 scoreboard and virtual dartboard. |

Dependencies run one way: `schema <- engine <- stats <- server`. Nothing imports
the bridge; they talk over a websocket.

Node 24+ runs the TypeScript sources directly via type stripping, so the backend
has **no build step**. Persistence uses `node:sqlite`, built into Node, so there
is no native module to compile.

## Running it

To run the app from source:

```bash
cp .env.example .env
docker compose up --build
```

Then open `http://localhost:8099`. Add a couple of players, start a match, and
click the dartboard to throw.

For local development without containers, install Node 24+ and run `npm ci` first:

```bash
npm run dev:bridge     # terminal 1
npm run dev:server     # terminal 2
npm run dev:frontend   # terminal 3, serves on :5173
```

For a desktop development window (also requires Python 3.10+ for its managed detector; see the [desktop guide](../packages/desktop/README.md)):

```bash
npm run build
npm run dev:desktop
```

### Event sources

Set `SOURCE` in `.env`:

| Value | Behaviour |
|---|---|
| `simulator` | Darts arrive from the frontend's virtual board. The default. |
| `autodarts` | Live board at `BOARD_URL`. |
| `native` | Our experimental local image detector at `DETECTOR_URL` (default `http://127.0.0.1:8091`). |
| `replay` | Replays a recorded capture from `REPLAY_FILE`. |

Simulated darts are posted to the **bridge**, not straight into the game server,
so they travel the same path real darts will.

For native detector setup and camera experiments, see [Native detection playground](native-detection.md).

### The fake board

`simulator` and `replay` both bypass the network, so neither exercises the live
board path — reconnection, the heartbeat, takeout detection. `@darts/fakeboard`
is a stand-in Board Manager that speaks the real local protocol on port 3180, so
`SOURCE=autodarts` can be tested with no hardware and no cloud:

```bash
npm run dev:fakeboard                                          # terminal 1
SOURCE=autodarts BOARD_URL=http://localhost:3180 npm run dev:bridge

curl -X POST localhost:3180/sim/turn -d '{"segments":["T20","T20","T20"]}'
curl -X POST localhost:3180/sim/throw -d '{"segment":"D16"}'
curl -X POST localhost:3180/sim/disconnect -d '{"ms":5000}'    # test the indicator
```

Under compose: `docker compose --profile fake up`. The control endpoints live
under `/sim`, never `/api`, so nothing there can be mistaken for a real board
path.

**It proves the bridge, not the protocol.** The fake emits the throw payload
recorded in `recon/FINDINGS.md` §3 — now confirmed against the real board,
coordinate frame included — but a green test still only says the bridge handles
the shape the fake sends. The protocol claim rests on the capture, not the fake.

### Manuals

Each game has a manual — its full rules — behind the **manual** button on the
setup screen, next to the game tabs. They are plain markdown files in
`packages/frontend/src/manuals/`, one per game type and named after it, pulled
into the bundle as raw text and rendered by the small markdown subset in
`packages/frontend/src/markdown.ts` (headings, lists, tables, code, quotes and
rules; everything escaped, since it goes through `v-html`). Editing a manual is
editing a document — nothing else needs wiring up, and a file left empty simply
reports that there is no manual yet.

The engine entry point for a new game is one file in `packages/engine/src/` plus
one entry in `registry.ts`. Also add its config schema, setup UI, scoreboard,
manual, statistics and achievements as appropriate; see [AGENTS.md](../AGENTS.md).

## The anti-corruption boundary

`packages/bridge/src/adapters/autodarts.ts` is the **only** file that knows
Autodarts field *names*. (`packages/bridge/src/boardControl.ts` knows its control
*paths*.) Everything else depends on `@darts/schema`.

All of it is now confirmed against the real board (`recon/FINDINGS.md`): the
transport, the `{type, data}` envelope, the channel names and rates, the full
local control API, and the throw payload — `coords` is `{x, y}` normalised by
170, origin at the bull, **x right and y up**; `segment` carries `number` and
`multiplier` alongside `name`/`bed`; and `throws[]` is cumulative for the visit
rather than per turn.

Detection 2.1 uses camelCase status names (`throw`, `takeoutInProgress`) and
flat dart fields (`segmentName`, `segmentNumber`, `bed`, `coordsX`, `coordsY`).
The bridge translates both this format and the older nested format into the
same events. The settings panel derives the dart count from `throws[]` when
`numThrows` is absent. HTTP polling also restores the status indicator while
the board is idle; it never scores darts from a snapshot.

Two rules keep the boundary worth having:

- **`coords` is nullable and nothing depends on it.** Game logic, statistics and
  the scoreboard all work with `coords: null`, because a dart's segment is
  enough to score it. Achievements that need coordinates simply evaluate to
  nothing for a dart without them.
- **The adapter parses strictly and fails loudly.** A silent mis-parse would
  produce a plausible-but-wrong score and quietly corrupt career statistics. An
  unexpected payload logs the offending frame and names the file to fix.

## Packaging

The desktop app is an Electron shell around the **unmodified** backend — it
starts `packages/bridge` and `packages/server` as child processes and points a
window at the scoreboard. No game logic lives in it. The docker deployment and
the desktop app run the same program, which is the only way both stay tested.

It ships with its own Node 24 runtime rather than using Electron's embedded
Node, which is currently Node 20. That is not caution — the backend runs
TypeScript by type stripping and stores data through `node:sqlite`, and Node 20
has neither.

```bash
npm run dev:desktop    # run the shell against the working tree
npm run package        # stage, then build an installer into build/release
```

`scripts/package/prepare.mjs` assembles a self-contained app in `build/app`:
backend sources, the built frontend, third-party dependencies, and a checksummed
Node runtime downloaded from nodejs.org. `scripts/package/verify-package.mjs`
then runs the *packed* app from a temporary directory outside this repo — which
matters more than it sounds, because Node resolves bare imports by walking up
parent directories, so a packed app sitting inside the workspace will find
`@darts/*` in the repo's own `node_modules` and pass a test it should fail.

### Releases from GitHub

[Release Please](https://github.com/googleapis/release-please) maintains a release
PR after changes land on `master`. Use Conventional Commit titles when squash
merging PRs: `fix: ...` for a patch, `feat: ...` for a minor version, and
`feat!: ...` for a major version. Other titles such as `docs: ...` and `ci: ...`
do not trigger a release by themselves.

The **Conventional PR title** check validates PR titles, including after edits.
Scopes are optional: both `fix: correct scoring` and `fix(engine): correct scoring`
are valid. Use squash merging and keep the PR title as the merge commit title.
To block merges with invalid titles, add **Conventional PR title** as a required
status check in the `master` branch rules. The title workflow reads PR metadata
with read-only permissions and never checks out contributor code.

Dependabot checks npm workspaces and GitHub Actions weekly. Minor and patch npm
updates are grouped; major updates are ignored for both ecosystems. npm PRs use `fix(deps):` (or
`fix(deps-dev):` for development dependencies) so they trigger patch releases;
GitHub Actions updates use `chore(deps):` and do not trigger releases by themselves.

Review the generated changelog and version bump, then merge the release PR in
GitHub. The workflow creates a draft release, builds and verifies the Windows
and Linux installers, and publishes only after both succeed. The app then offers
the update. Every workspace manifest and its lockfile version are bumped together.
The workflow calls the installer build directly because tags created with
`GITHUB_TOKEN` do not trigger another workflow.

One-time repository setting: under **Settings → Actions → General → Workflow
permissions**, enable **Allow GitHub Actions to create and approve pull requests**.
No personal access token is needed. Release PRs created by `GITHUB_TOKEN` do not
trigger the ordinary PR checks; the installer workflow runs the full
`npm run check` gate on both platforms before publishing.
If the title check is required, a maintainer must edit a generated release PR's
title to trigger it (for example, add a description after the version), since
bot events from `GITHUB_TOKEN` do not start the title workflow either.

If a build fails, the release stays a draft. Retry the failed jobs, or use
**Actions → release → Run workflow**, enter the existing tag (for example
`v0.4.3`), and enable **Publish after both installers pass verification**.
Manual runs check out that tag regardless of the branch selected in the UI.
Tag pushes and manual runs without that option still upload to a draft for
manual publication. `npm run release` remains available as a legacy manual path;
use the release PR workflow for normal releases.

## Checks

```bash
npm run check      # typecheck (backend + frontend) and tests
npm test           # TypeScript tests, no hardware required
```

## The command log is the source of truth

Every command is appended to the `commands` table. Match state, career
statistics and achievement progress are **projections** derived by folding that
log. Undo and correction edit the log and replay it, which is why undo is
correct for every game without each engine unwinding its own state.

Three things fall out of this that are painful to retrofit:

1. **New achievements backfill.** Add one a year from now and it evaluates
   against every dart ever thrown, dated to the match that earned it — rather
   than starting at zero the day it was written.
2. **Statistics are fixable retroactively.** Correct a definition, re-run, and
   history is corrected too.
3. **Corrections propagate.** Fixing a misdetected dart updates the match,
   career statistics and achievements consistently.

Ordinary commands append one durable log entry and update a live analysis with
only the new command. Undo and correction replace the edited log and rebuild
that analysis. Recent-dart views are cached too, so routine scoring does not
replay or rewrite the whole match as the game grows. Simulated throws and real
board throws use this same path.

Progress is written after every dart, so bars move during a match rather than
only when it ends, and every achievement declares its target statically so a
player who has never thrown still sees "0 / 10" rather than "0 / 1".

```bash
npm run achievements:backfill        # after adding an achievement
```

Achievements live in `packages/stats/src/achievements/catalogue.ts`, one entry
each. The same rebuild is available from the Settings page.

Finishing a match updates its throws, the participants' career totals and their
achievements using cached history. It does not replay and backfill every past
match, so the results screen is not followed by a full rebuild that blocks
starting the next game.

Two of them read `coords`: **Tight Grouping** (three darts of one turn inside a
20 mm circle, measured as the smallest circle enclosing all three) and **Robin
Hood** (two darts of one turn landing within 5 mm of each other, a shaft's
width). Both compare darts *within a single turn only* — darts are pulled out
between turns — and a turn with any unlocated dart cannot unlock either.
