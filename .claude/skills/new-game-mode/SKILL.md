---
name: new-game-mode
description: Add a new darts game mode (engine, config schema, setup UI, scoreboard panel, stats and achievements) to this repo. Use when asked to add, implement, or scaffold a game — "add Around the Clock", "new game mode", "implement Halve It", "add a game to the engine registry" — or when changing the rules/config of an existing game, since the same touchpoint list applies.
---

# Adding a game mode

A game is one engine file plus one config schema; everything else is optional
polish that the game degrades gracefully without. Do the required tier first and
get `npm run check` green before touching the UI or stats.

## 0. Pin the rules before writing code

Ask the user, or state your assumptions explicitly, for each of these — every
one of them changes the engine's shape:

- **What scores.** Which darts count, at what value, and what a miss does.
- **What ends a turn.** Three darts always, or early (a bust, a hole finished,
  an instant win)?
- **What ends a leg.** A target reached, a fixed number of rounds, last player
  standing.
- **Turn order.** Does everyone play the same round before it advances
  (Shanghai), or does each player run their own card (Golf)?
- **Elimination.** Can a player be out of the leg while others keep throwing?
  That needs the `skip` predicate of `advanceTurn`.
- **Config knobs**, including whether the game has a per-player handicap.
- **"Closest to winning"** for `END_MATCH` — the engine is the only thing that
  knows whether a low number is good.

Write these into the doc comment at the top of the engine file. Existing engines
all carry one; it is where the rules actually live.

## 1. Required: schema

[packages/schema/src/match.ts](../../../packages/schema/src/match.ts)

1. Add `<Game>ConfigSchema` — a `z.object` with `gameType: z.literal('<game>')`,
   the game's knobs each with a `.default(...)`, and `legsToWin` / `setsToWin`
   (`z.number().int().positive()`). Export the inferred type.
2. Add it to the `GameConfigSchema` discriminated union. `GameType` is derived
   from that union, so this one edit is what makes the new id legal everywhere.
3. Add any new `DomainEvent` variants, namespaced `'<game>.<thing>'`, to the
   union at the bottom. Only add an event if stats or achievements will read it;
   the generic `turn.completed` / `leg.won` / `match.won` events are emitted by
   every game and cover most needs.

Every field needs a default: the frontend posts a partial config and
`parseConfig` fills the rest in.

## 2. Required: the engine

New file `packages/engine/src/<game>.ts`, implementing `GameEngine<Cfg, State>`
from [types.ts](../../../packages/engine/src/types.ts). Read
[shanghai.ts](../../../packages/engine/src/shanghai.ts) first — it is the
smallest complete example (shared rounds, an instant win, a per-player card).
[golf.ts](../../../packages/engine/src/golf.ts) is the one to copy for per-player
handicaps, [killer.ts](../../../packages/engine/src/killer.ts) for elimination.

State is `{ base: BaseState; ...game state }`. Keep it plain JSON — `clone()` is
`structuredClone`, and the state is refolded from the log constantly.

`reduce` switches over `ForwardCommand` and must handle all eight cases:

| Command | Obligation |
|---|---|
| `START` | no-op unless `status === 'idle'`; set `playing`, emit `match.started` |
| `THROW` | reject unless `playing` and not `turnEnded`; push to `base.turn`, bump `base.legDarts`, emit `throw.recorded` with the *scored* value |
| `NEXT_PLAYER` | ends the turn early; if `base.turnEnded` just `advanceTurn` |
| `ADVANCE_TURN` | no-op unless `base.turnEnded`; `advanceTurn` + your `beginTurn` |
| `RESTART_LEG` | reset to `legStartIndex`, clear turn and `legDarts`, reset game state |
| `ADD_PLAYER` / `REMOVE_PLAYER` | `addPlayerToBase` / `removePlayerFromBase`, then seed or delete *every* per-player record you keep |
| `END_MATCH` | `endMatchEarly(base, progress)`; negate `progress` if low is good |

Use the helpers in [base.ts](../../../packages/engine/src/base.ts) —
`createBaseState`, `activePlayer`, `advanceTurn`, `turnIsComplete`, `awardLeg`,
`endMatchEarly`, `clone`, `addPlayerToBase`, `removePlayerFromBase`. Do not
reimplement leg/set rollup: `awardLeg` handles legs, sets, the rotation of
`legStartIndex` and the `match.won` event, and calls your `onNewLeg` callback to
reset game state.

Rules that are easy to get wrong:

- **Never mutate `prev`.** `const state = clone(prev)`, and return
  `{ state: prev, events: [] }` for rejected commands.
- **No UNDO or CORRECT_THROW.** [match.ts](../../../packages/engine/src/match.ts)
  edits the log and refolds. Engines only move forward.
- **The takeout hold.** When a turn ends on a `THROW`, set `base.turnEnded = true`
  and leave `activeIndex` and `base.turn` alone — the darts stay visible until
  the board reports takeout. The exception is a turn that *wins* the leg, where
  `awardLeg` clears everything itself.
- **`coords` is nullable.** Scoring must be correct with `coords: null`. Read
  `dart.segment` and `dart.value`, never `dart.coords`.
- **Node type-stripping.** No enums, no parameter properties, no namespaces, and
  imports carry the `.ts` extension.

`view` returns a `MatchView`. `score` is the one big number; everything
game-specific goes in `detail` (a `Record<string, unknown>` the scoreboard reads
back with casts). `turn.hints` is one label per remaining dart — emit whole
numbers (`'20'`) for aim-at-a-number games and ring labels (`'T20'`) otherwise;
see step 5.

Then register it: import and add one line to `engines` in
[registry.ts](../../../packages/engine/src/registry.ts) (with the
`as unknown as AnyEngine` cast every entry uses), and one `export *` line in
[index.ts](../../../packages/engine/src/index.ts).

## 3. Required: tests

`packages/engine/src/<game>.test.ts`, modelled on
[shanghai.test.ts](../../../packages/engine/src/shanghai.test.ts): a local
`newMatch(overrides)` helper building a `Match`, `beforeEach(resetDartIds)`, and
`play()` / `throwCmd()` / `scoreOf()` from
[testkit.ts](../../../packages/engine/src/testkit.ts). Note `play()` releases the
takeout hold for you; drive `ADVANCE_TURN` by hand only when testing the hold
itself.

Cover: scoring (including what does *not* score), turn end, leg end and the
winner, each config knob, undo across a turn boundary, and `END_MATCH` picking
the right leader. Add a case to
[endMatch.test.ts](../../../packages/engine/src/endMatch.test.ts), which keeps
one per game.

Run `npm run check` — typecheck plus the full suite — before going further.

## 4. Optional: setup UI

[MatchSetup.vue](../../../packages/frontend/src/components/MatchSetup.vue) needs
four edits, and missing any one of them is the usual bug:

1. the local `GameType` union and the label map at the top;
2. `refs` for the new knobs;
3. a branch in `buildConfig()` returning the config object;
4. a branch in the "load previous setup" block that restores those refs;
5. the `v-for` list of game ids on the picker, and a `<template v-else-if>`
   block with the inputs.

## 5. Optional: scoreboard and board hints

- [Scoreboard.vue](../../../packages/frontend/src/components/Scoreboard.vue):
  an `is<Game>` computed, a small accessor casting `p.detail` to your shape, a
  panel in the template and its styles.
- [App.vue](../../../packages/frontend/src/App.vue): if hints name a whole
  number rather than a ring, add the id to `WHOLE_NUMBER_HINT_GAMES`.

The frontend must not import `@darts/engine` — it speaks `@darts/schema` only,
and stats types are re-declared in `store.ts` deliberately.

## 6. Optional: stats, handicap, achievements

- [analysis.ts](../../../packages/stats/src/analysis.ts) is engine-agnostic and
  already replays the log; only add a `if (record.gameType === '<game>')` block
  if the game has a card worth extracting (read it off the final view's
  `detail`, as golf and shanghai do).
- [career.ts](../../../packages/stats/src/career.ts): fields on `CareerStats`,
  zeros in `emptyCareer`, the fold. Then mirror the fields into
  [leaderboard.ts](../../../packages/stats/src/leaderboard.ts).
- Handicap: [handicap.ts](../../../packages/stats/src/handicap.ts) plus the
  prefill branch in [main.ts](../../../packages/server/src/main.ts) around the
  match-create route.
- Achievements: an entry in
  [catalogue.ts](../../../packages/stats/src/achievements/catalogue.ts), then
  **`npm run achievements:backfill`** so it applies over existing history.
  Achievements must reconcile in both directions — an undo withdraws what it
  earned — so evaluate purely from `MatchAnalysis`/`CareerStats`, never from a
  running tally.

## 7. Document it

Add a section to the **Games** part of [README.md](../../../README.md) — rules,
each config knob and why it exists. The README is where behaviour is specified;
CLAUDE.md only covers working in the tree.

## Done check

```bash
npm run check                       # the whole gate
npx vitest run packages/engine/src/<game>.test.ts
```

Then play it: `npm run dev:bridge`, `npm run dev:server`, `npm run dev:frontend`
with `SOURCE=simulator` — simulated darts are POSTed to the bridge, so they
travel the same path a real dart does.
