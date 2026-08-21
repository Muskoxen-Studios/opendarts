# Graph Report - .  (2026-08-21)

## Corpus Check
- 139 files · ~101,027 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1324 nodes · 2508 edges · 78 communities (68 shown, 10 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 111 edges (avg confidence: 0.77)
- Token cost: 144,470 input · 0 output

## Community Hubs (Navigation)
- Board Geometry and Dart Visuals
- Engine Game Test Suites
- Fakeboard Simulator and Control API
- Design Rationale and Feature Concepts
- Schema Events and Server Router
- Match Setup Screen
- SQLite Store and Command Log
- Root Package and Build Tooling
- MatchManager, DB Migrations, Backfill
- CI, Release, Docker, Electron Packaging
- Achievements Catalogue and Evaluation
- Bridge Server and Board Control
- Match Analysis, Summary, Heatmap
- Frontend App Shell
- Settings Panel and Source Config
- Leaderboard View and Archives
- Bridge Event Sources
- Player Profile Panel
- Engine Base State, Gotcha, Shanghai
- Scoreboard Component
- Desktop Packaging Scripts
- Electron Main Process and Runtime
- Frontend Package Manifest
- Frontend TypeScript Config
- Frontend Reactive Store
- Shared TypeScript Base Config
- Release Version Script
- X01 Engine and Checkout Hints
- Match Overview Report View
- Per-Mode Handicap Computation
- Board Controls Component
- Server Package Manifest
- Match Config Schemas
- Career Stats and Golf Handicap
- Bridge Package Manifest
- Desktop Package Manifest
- Autodarts Adapter Boundary
- Leaderboard Ranking and Heatmap
- Engine Registry and Match Wrapper
- Killer Engine
- Cricket Engine
- Server and Stats Public Types
- HAR Capture Extraction Tool
- Source Manager Lifecycle
- Fakeboard Package Manifest
- Stats Package Manifest
- Autodarts Source Integration
- Per-Game Engine State Types
- Golf Engine
- Engine Package Manifest
- Schema Package Manifest
- Game Mode Rules Documentation
- Root TypeScript Project Refs
- Icon Generation Script
- App Icon Design
- GameEngine Interface Contract
- Unlock Celebration Component
- Vitest Skill Reference
- Bridge TS Config
- Engine TS Config
- Fakeboard TS Config
- Handicap Loading in Setup
- Schema TS Config
- Server TS Config
- Stats TS Config
- Websocket Listen Recon Tool
- Electron afterPack Hook
- Adding a Game Mode
- Setup Config Emit Flow
- Throw Capture Recon Script
- Protocol Probe Script
- Endpoint Sweep Script
- Coords Nullability and Open TODO
- Last-Settings Reuse
- Vue Type Shim
- Release and Auto-Update

## God Nodes (most connected - your core abstractions)
1. `Store` - 45 edges
2. `Match` - 31 edges
3. `Player` - 27 edges
4. `Segment` - 23 edges
5. `FakeBoard` - 21 edges
6. `MatchManager` - 21 edges
7. `players()` - 19 edges
8. `pushToast()` - 19 edges
9. `MatchView` - 19 edges
10. `play()` - 18 edges

## Surprising Connections (you probably didn't know these)
- `@darts/fakeboard stand-in Board Manager` --conceptually_related_to--> `toRawCoords()`  [INFERRED]
  README.md → packages/fakeboard/src/payload.ts
- `The anti-corruption boundary` --references--> `toCoords()`  [EXTRACTED]
  README.md → packages/bridge/src/adapters/autodarts.ts
- `Coordinate frame: normalised by 170, bull origin, x right y up` --references--> `toCoords()`  [EXTRACTED]
  recon/FINDINGS.md → packages/bridge/src/adapters/autodarts.ts
- `Correction: y points UP, not down` --references--> `toRawCoords()`  [EXTRACTED]
  recon/FINDINGS.md → packages/fakeboard/src/payload.ts
- `Release workflow: build matrix job` --shares_data_with--> `GitHub publish target Muskoxen-Studios/opendarts (draft)`  [INFERRED]
  .github/workflows/release.yml → electron-builder.yml

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Compose stack: board -> bridge -> server -> frontend** — docker_compose_fakeboard, docker_compose_bridge, docker_compose_server, docker_compose_frontend [EXTRACTED 1.00]
- **Tag-to-installer release flow** — claude_release_script, _github_workflows_release_build, _github_workflows_release_prepare_mjs, electron_builder_config, _github_workflows_release_verify_package, packages_desktop_readme_symlink_workspace_links [EXTRACTED 1.00]
- **Consequences of running TypeScript without a build step** — claude_no_build_step, packages_desktop_readme_bundled_node_runtime, packages_desktop_readme_symlink_workspace_links, electron_builder_asar_disabled, claude_npm_run_check [INFERRED 0.85]
- **The y-axis correction: bug, evidence and the guard that now prevents it** — readme_y_axis_bug, recon_findings_y_up_correction, recon_findings_coordinate_frame, recon_findings_radius_cannot_confirm_axis, readme_roundtrip_angle_test [EXTRACTED 1.00]
- **Command log projections: stats, achievements, undo and seasons** — readme_command_log_source_of_truth, readme_achievements, readme_unlocks_are_a_projection, readme_season_window, readme_golf_handicap [EXTRACTED 1.00]
- **Board protocol ingestion: transport, channels, payload and the boundary that contains them** — recon_findings_transport, recon_findings_channels, recon_findings_throw_payload, recon_findings_throws_cumulative, readme_anti_corruption_boundary, readme_fakeboard [EXTRACTED 1.00]

## Communities (78 total, 10 thin omitted)

### Community 0 - "Board Geometry and Dart Visuals"
Cohesion: 0.05
Nodes (65): satisfiesMode(), hintSegments, band(), BOARD_RADIUS, BoardCell, boardCells(), BULL_INNER_R, BULL_OUTER_R (+57 more)

### Community 1 - "Engine Game Test Suites"
Cohesion: 0.06
Nodes (45): computeCheckout(), [ALICE, BOB], newMatch(), nineDarter(), ROSTER, start(), X01, handicapOf() (+37 more)

### Community 2 - "Fakeboard Simulator and Control API"
Cohesion: 0.07
Nodes (40): board(), deadUrl(), BoardStateData, FakeBoard, StateListener, board(), ControlDeps, handleControl() (+32 more)

### Community 3 - "Design Rationale and Feature Concepts"
Cohesion: 0.06
Nodes (47): Achievements catalogue and progress, The anti-corruption boundary, Four-stage pipeline: Board Manager -> bridge -> server -> frontend, Unlock celebrations, The command log is the source of truth, coords is nullable and nothing depends on it, Electron shell around the unmodified backend, Event sources: simulator / autodarts / replay (+39 more)

### Community 4 - "Schema Events and Server Router"
Cohesion: 0.06
Nodes (34): BoardEventSchema, BoardStatusSchema, CoordsSchema, DartThrowSchema, RingSchema, SegmentSchema, ThrowSource, ThrowSourceSchema (+26 more)

### Community 5 - "Match Setup Screen"
Cohesion: 0.05
Nodes (39): busy, canStart, endRound, error, exactFinish, filteredProfiles, friendlyFire, GAME_LABELS (+31 more)

### Community 6 - "SQLite Store and Command Log"
Cohesion: 0.08
Nodes (6): MatchCommand, defaultArchiveLabel(), Store, toProfile(), MatchRecord, condenseRow()

### Community 7 - "Root Package and Build Tooling"
Cohesion: 0.05
Nodes (38): electron-builder, allowScripts, electron@33.4.11, electron-winstaller@5.4.0, esbuild@0.25.12, devDependencies, electron-builder, @types/node (+30 more)

### Community 8 - "MatchManager, DB Migrations, Backfill"
Cohesion: 0.08
Nodes (14): migrate(), openDatabase(), MatchManager, ServerEvent, db, result, seconds, started (+6 more)

### Community 9 - "CI, Release, Docker, Electron Packaging"
Cohesion: 0.07
Nodes (35): CI workflow: check job, Release workflow: build matrix job, Draft release create-or-upload race handling, scripts/package/prepare.mjs staging step, verify-package.mjs packed-app smoke check, Anti-corruption boundary around Autodarts field names, SOURCE modes: simulator | autodarts | replay, The command log is the source of truth (+27 more)

### Community 10 - "Achievements Catalogue and Evaluation"
Cohesion: 0.11
Nodes (18): CATALOGUE, CATALOGUE_BY_ID, distMm(), enclosingRadiusMm(), Point, backfillPlayer(), evaluateMatch(), EvaluateOptions (+10 more)

### Community 11 - "Bridge Server and Board Control"
Cohesion: 0.11
Nodes (21): BOARD_ACTIONS, BoardAction, boardCommand(), BoardCommandResult, boardState(), isBoardAction(), RawBoardState, RawBoardThrow (+13 more)

### Community 12 - "Match Analysis, Summary, Heatmap"
Cohesion: 0.13
Nodes (24): GolfHoleResult, Coords, analyzeMatch(), CheckoutRecord, GolfAnalysis, KnockbackRecord, labelOf(), ThrowRecord (+16 more)

### Community 13 - "Frontend App Shell"
Cohesion: 0.10
Nodes (21): activePlayer, addToMatch(), availableToJoin, correcting, endGame(), hintNumbers, managingRoster, onThrow() (+13 more)

### Community 14 - "Settings Panel and Source Config"
Cohesion: 0.10
Nodes (24): applying, applySource(), boardUrl, buildConfig(), busy, debugMotion, dirty, host (+16 more)

### Community 15 - "Leaderboard View and Archives"
Cohesion: 0.09
Nodes (17): ARCHIVE_COLUMNS, archives, board, COLUMNS, expanded, load(), loading, openArchive (+9 more)

### Community 16 - "Bridge Event Sources"
Cohesion: 0.16
Nodes (11): buildSource(), describeSource(), Emit, BOARD, SIM, RecordedLine, ReplayOptions, replaySource() (+3 more)

### Community 17 - "Player Profile Panel"
Cohesion: 0.10
Nodes (18): achievements, add(), busy, color, draftColor, draftName, editing, HEADLINE (+10 more)

### Community 18 - "Engine Base State, Gotcha, Shanghai"
Cohesion: 0.18
Nodes (19): activePlayer(), addPlayerToBase(), advanceTurn(), awardLeg(), clone(), createBaseState(), DARTS_PER_TURN, endMatchEarly() (+11 more)

### Community 19 - "Scoreboard Component"
Cohesion: 0.09
Nodes (14): activePlayer, cricketTargets, GolfHole, isCricket, isGolf, isKiller, isOut(), isShanghai (+6 more)

### Community 20 - "Desktop Packaging Scripts"
Cohesion: 0.12
Nodes (14): BACKEND_PACKAGES, fetchRuntime(), log(), OUT, REPO, run(), RUNTIME_DEPENDENCIES, runtimeArchive() (+6 more)

### Community 21 - "Electron Main Process and Runtime"
Cohesion: 0.15
Nodes (19): { app, BrowserWindow, Menu, clipboard, dialog, session, shell }, boot(), buildMenu(), checkForUpdates(), children, CSP, { findFreePort, findNodeRuntime, lanAddresses, waitForServer }, { join } (+11 more)

### Community 22 - "Frontend Package Manifest"
Cohesion: 0.10
Nodes (20): dependencies, @darts/schema, vue, devDependencies, vite, @vitejs/plugin-vue, vue-tsc, @darts/schema (+12 more)

### Community 23 - "Frontend TypeScript Config"
Cohesion: 0.10
Nodes (20): compilerOptions, allowImportingTsExtensions, isolatedModules, jsx, lib, module, moduleResolution, noEmit (+12 more)

### Community 24 - "Frontend Reactive Store"
Cohesion: 0.15
Nodes (17): announce(), BridgeStatus, Celebration, connect(), dismissCelebration(), enqueueCelebration(), fireBoardEffect(), GolfHoleResult (+9 more)

### Community 25 - "Shared TypeScript Base Config"
Cohesion: 0.11
Nodes (18): ES2023, compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, exactOptionalPropertyTypes, isolatedModules, lib, module (+10 more)

### Community 26 - "Release Version Script"
Cohesion: 0.16
Nodes (16): args, compareVersions(), currentVersion(), die(), dirty, from, log(), manifestPaths() (+8 more)

### Community 27 - "X01 Engine and Checkout Hints"
Cohesion: 0.18
Nodes (13): CANDIDATES, checkoutCache, dartDifficulty(), finishers(), isBogeyNumber(), suggestCheckout(), beginTurn(), resetLegScores() (+5 more)

### Community 28 - "Match Overview Report View"
Cohesion: 0.12
Nodes (13): emit, focus, golfHoles(), heatColor, heatmap, holeCount, isGolf, isX01 (+5 more)

### Community 29 - "Per-Mode Handicap Computation"
Cohesion: 0.23
Nodes (15): GameType, MatchAnalysis, clampInt(), computeGotchaHandicap(), computeKillerHandicap(), computeX01Handicap(), countedMatches(), HANDICAP_BEST (+7 more)

### Community 30 - "Board Controls Component"
Cohesion: 0.12
Nodes (16): busy, error, LABELS, noBoard, numThrows, props, reachable, refresh() (+8 more)

### Community 31 - "Server Package Manifest"
Cohesion: 0.13
Nodes (14): @darts/stats, dependencies, @darts/engine, @darts/schema, @darts/stats, ws, exports, @darts/engine (+6 more)

### Community 32 - "Match Config Schemas"
Cohesion: 0.13
Nodes (14): CRICKET_TARGETS, GOLF_HOLES, GOLF_PAR, GotchaConfigSchema, InOutModeSchema, KillerConfigSchema, PlayerSchema, ShanghaiConfig (+6 more)

### Community 33 - "Career Stats and Golf Handicap"
Cohesion: 0.21
Nodes (12): GOLF_BASE_HANDICAP, Accum, computeCareer(), emptyCareer(), clamp(), computeGolfHandicap(), countedRounds(), GOLF_HANDICAP_BEST (+4 more)

### Community 34 - "Bridge Package Manifest"
Cohesion: 0.14
Nodes (13): @darts/fakeboard, dependencies, @darts/schema, ws, devDependencies, @darts/fakeboard, exports, @darts/schema (+5 more)

### Community 35 - "Desktop Package Manifest"
Cohesion: 0.14
Nodes (13): electron, electron-updater, dependencies, electron-updater, description, devDependencies, electron, main (+5 more)

### Community 36 - "Autodarts Adapter Boundary"
Cohesion: 0.22
Nodes (10): BED_TO_RING, normalizeThrow(), numberFromName(), RawCoordsSchema, RawSegmentSchema, RawThrow, RawThrowSchema, ThrowShapeError (+2 more)

### Community 37 - "Leaderboard Ranking and Heatmap"
Cohesion: 0.23
Nodes (12): bestGolfCard(), compareRows(), computeLeaderboard(), foldTurns(), lastPlayedAt(), Leaderboard, LEADERBOARD_POINTS, LeaderboardOptions (+4 more)

### Community 38 - "Engine Registry and Match Wrapper"
Cohesion: 0.28
Nodes (8): AnyEngine, engineFor(), engines, GAME_TYPES, shanghaiEngine, EngineResult, ForwardCommand, DomainEvent

### Community 39 - "Killer Engine"
Cohesion: 0.18
Nodes (10): claimedNumbers(), killerEngine, KillerPlayerState, NUMBERS, randomUnclaimedNumber(), resetLeg(), seatPlayer(), KillerConfig (+2 more)

### Community 40 - "Cricket Engine"
Cohesion: 0.20
Nodes (7): closedByAll(), cricketEngine, hasClosedEverything(), isClosedBy(), MARKS_TO_CLOSE, CricketConfig, CricketConfigSchema

### Community 41 - "Server and Stats Public Types"
Cohesion: 0.24
Nodes (7): GameConfig, HANDICAP_BASE_DEFAULT, LeaderboardArchive, LeaderboardArchiveSummary, MatchSummary, Profile, ArchivedRow

### Community 42 - "HAR Capture Extraction Tool"
Cohesion: 0.18
Nodes (10): auth, byUrl, ctOf(), dumpBodies, ext, har, hosts, repeated (+2 more)

### Community 44 - "Fakeboard Package Manifest"
Cohesion: 0.18
Nodes (10): dependencies, @darts/schema, ws, exports, @darts/schema, ws, name, private (+2 more)

### Community 45 - "Stats Package Manifest"
Cohesion: 0.18
Nodes (10): dependencies, @darts/engine, @darts/schema, exports, @darts/engine, @darts/schema, name, private (+2 more)

### Community 46 - "Autodarts Source Integration"
Cohesion: 0.33
Nodes (5): AutodartsOptions, autodartsSource(), connect(), Harness, BoardEvent

### Community 47 - "Per-Game Engine State Types"
Cohesion: 0.20
Nodes (9): CricketState, GolfState, GotchaState, KillerState, ShanghaiState, BaseState, X01State, DartThrow (+1 more)

### Community 48 - "Golf Engine"
Cohesion: 0.24
Nodes (7): golfEngine, isDone(), makeSkip(), resetLeg(), seatPlayer(), GolfConfigSchema, PlayerView

### Community 49 - "Engine Package Manifest"
Cohesion: 0.22
Nodes (8): dependencies, @darts/schema, exports, @darts/schema, name, private, type, version

### Community 50 - "Schema Package Manifest"
Cohesion: 0.22
Nodes (8): dependencies, zod, exports, name, private, type, version, zod

### Community 51 - "Game Mode Rules Documentation"
Cohesion: 0.22
Nodes (9): Adding a game: one engine file plus one registry line, Checkout hints and route lighting, Cricket game mode (standard and cut-throat), Ending a game early (END_MATCH / closest to winning), Golf scored Stableford, Gotcha game mode, Leg end mode: first checkout vs all-but-one, Marks-per-round over completed rounds only (+1 more)

### Community 52 - "Root TypeScript Project Refs"
Cohesion: 0.25
Nodes (7): node_modules, packages/frontend, packages/*/src/**/*.ts, exclude, extends, include, ./tsconfig.base.json

### Community 53 - "Icon Generation Script"
Cohesion: 0.29
Nodes (6): band(), MM, ORDER, OUT, parts, polar()

### Community 54 - "App Icon Design"
Cohesion: 0.60
Nodes (6): Desktop App Branding / Electron Installer Icon, Dartboard Motif (20 wedges, doubles/trebles rings, bullseye), Icon Palette (dark #0c0e12/#20242b, cream #f5f0dc, green #3f9d54, red #d8453f), Darts App Icon (PNG raster, 1024x1024), Rounded-Square App Tile (rx 184.32 on 1024 canvas), Darts App Icon (SVG vector source)

### Community 56 - "Unlock Celebration Component"
Cohesion: 0.33
Nodes (5): Celebration, confetti, emit, props, tierLabel

### Community 57 - "Vitest Skill Reference"
Cohesion: 0.50
Nodes (5): skilld lock entry: vitest-skilld, Explicit Resource Management (`using`) for auto mock restore, Mock state isolation between tests, test.extend() fixtures with file/worker scope, vitest-skilld skill (vitest 3.2.7)

### Community 58 - "Bridge TS Config"
Cohesion: 0.40
Nodes (4): extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 59 - "Engine TS Config"
Cohesion: 0.40
Nodes (4): extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 60 - "Fakeboard TS Config"
Cohesion: 0.40
Nodes (4): extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 61 - "Handicap Loading in Setup"
Cohesion: 0.40
Nodes (5): handicapFor(), loadGotchaHandicaps(), loadKillerHandicaps(), loadModeHandicaps(), loadX01Handicaps()

### Community 62 - "Schema TS Config"
Cohesion: 0.40
Nodes (4): extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 63 - "Server TS Config"
Cohesion: 0.40
Nodes (4): extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 64 - "Stats TS Config"
Cohesion: 0.40
Nodes (4): extends, include, src/**/*.ts, ../../tsconfig.base.json

### Community 65 - "Websocket Listen Recon Tool"
Cohesion: 0.40
Nodes (3): args, out, stamp

### Community 67 - "Adding a Game Mode"
Cohesion: 0.67
Nodes (3): Adding a game: GameEngine + registry entry, Golf game mode scored Stableford, Shanghai and Killer game modes

### Community 68 - "Setup Config Emit Flow"
Cohesion: 0.67
Nodes (3): buildConfig(), emit, start()

## Ambiguous Edges - Review These
- `Icon Palette (dark #0c0e12/#20242b, cream #f5f0dc, green #3f9d54, red #d8453f)` → `Desktop App Branding / Electron Installer Icon`  [AMBIGUOUS]
  build-resources/icon.svg · relation: conceptually_related_to

## Knowledge Gaps
- **455 isolated node(s):** `name`, `private`, `version`, `type`, `packages/*` (+450 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Icon Palette (dark #0c0e12/#20242b, cream #f5f0dc, green #3f9d54, red #d8453f)` and `Desktop App Branding / Electron Installer Icon`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `Segment` connect `Board Geometry and Dart Visuals` to `Engine Game Test Suites`, `Fakeboard Simulator and Control API`, `Autodarts Adapter Boundary`, `Schema Events and Server Router`, `MatchManager, DB Migrations, Backfill`, `Bridge Server and Board Control`, `Frontend App Shell`, `Autodarts Source Integration`, `Bridge Event Sources`, `Frontend Reactive Store`, `X01 Engine and Checkout Hints`?**
  _High betweenness centrality (0.052) - this node is a cross-community bridge._
- **Why does `Store` connect `SQLite Store and Command Log` to `Schema Events and Server Router`, `Leaderboard Ranking and Heatmap`, `MatchManager, DB Migrations, Backfill`, `Server and Stats Public Types`, `Achievements Catalogue and Evaluation`, `Match Analysis, Summary, Heatmap`, `Per-Mode Handicap Computation`?**
  _High betweenness centrality (0.024) - this node is a cross-community bridge._
- **Why does `toCoords()` connect `Autodarts Adapter Boundary` to `Design Rationale and Feature Concepts`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **What connects `name`, `private`, `version` to the rest of the system?**
  _455 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Board Geometry and Dart Visuals` be split into smaller, more focused modules?**
  _Cohesion score 0.05146242132543503 - nodes in this community are weakly interconnected._
- **Should `Engine Game Test Suites` be split into smaller, more focused modules?**
  _Cohesion score 0.06436487638533675 - nodes in this community are weakly interconnected._