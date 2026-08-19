# darts

A self-hosted darts game server and scoreboard built on Autodarts camera
hardware, using the Autodarts Board Manager purely as a **local detection
source**. No dependency on `api.autodarts.io` and no cloud game service.

## Status

Playable end to end today with a clickable virtual dartboard. Switching to real
hardware is one environment variable.

One thing is still unknown: the exact shape of the board's throw payload. It is
isolated to a single function — see [Waiting on the throw payload](#waiting-on-the-throw-payload).

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
| `@darts/engine` | Pure game logic: X01, Cricket, Gotcha. No I/O. |
| `@darts/stats` | Statistics and achievements, computed as projections. |
| `@darts/bridge` | Board adapter, plus simulator and replay sources. |
| `@darts/server` | Match state, profiles, persistence, WS + REST API. |
| `@darts/frontend` | Vue 3 scoreboard and virtual dartboard. |

Dependencies run one way: `schema <- engine <- stats <- server`. Nothing imports
the bridge; they talk over a websocket.

Node 24+ runs the TypeScript sources directly via type stripping, so the backend
has **no build step**. Persistence uses `node:sqlite`, built into Node, so there
is no native module to compile.

## Running it

```bash
npm install
cp .env.example .env
docker compose up --build
```

Then open `http://localhost:8099`. Add a couple of players, start a match, and
click the dartboard to throw.

For local development without containers:

```bash
npm run dev:bridge     # terminal 1
npm run dev:server     # terminal 2
npm run dev:frontend   # terminal 3, serves on :5173
```

### Event sources

Set `SOURCE` in `.env`:

| Value | Behaviour |
|---|---|
| `simulator` | Darts arrive from the frontend's virtual board. The default. |
| `autodarts` | Live board at `BOARD_URL`. |
| `replay` | Replays a recorded capture from `REPLAY_FILE`. |

Simulated darts are posted to the **bridge**, not straight into the game server,
so they travel the same path real darts will.

## Games

**X01** — 301/501/701, straight/double/master in and out, legs and sets, bust
handling, and checkout hints.

The suggested route is also lit up on the board itself: the dart to throw now
is brightest, the rest of the route dimmer behind it.

The checkout route fills the remaining dart slots on the scoreboard, recomputed
after every throw and respecting that player's out-rule — so on 170 the three
slots read T20, T20, BULL, and after the first dart they read T20, BULL.

By default a leg ends the moment someone checks out. Set **leg ends: when all
but one player has checked out** and play continues instead, so everyone gets a
finishing place — the leg is still won by whoever went out first. With two
players the two settings are equivalent.

Hints appear **only when the score is actually checkable with the darts left**.
On 501, on 171, or on a bogey number such as 169, the slots stay empty rather
than offering advice on a finish that is not there. Under straight-out, 20
finishes on S20 rather than D10 — same score, far easier dart.

Handicaps are per-player overrides of the start score *and* the in/out rule, so
a stronger player can play 501 double-out against 301 straight-out in the same
leg:

```json
{ "gameType": "x01", "startScore": 501, "outMode": "double",
  "perPlayer": { "<profileId>": { "startScore": 301, "outMode": "straight" } } }
```

**Cricket** — standard and cut-throat. In cut-throat, points go to opponents who
have not closed the number and the lowest score wins.

Marks-per-round is computed over **completed rounds only**. Dividing running
marks by a fractional round makes the figure meaningless mid-turn — a treble on
the first dart would read as 9.00 MPR.

**Gotcha** — count up to a target, overshoot busts. Landing exactly on an
opponent's total knocks them back, either to `zero` or to `previousTurn`.

**Golf, scored Stableford** — 18 holes on the board's own numbers: hole 7 is the
7. Every dart is a stroke and the hole is holed the moment you hit that number
in any ring, so a first-dart hit on a par-4 hole is an albatross. A hole is
abandoned one stroke over par, for nothing. Play rotates in ordinary three-dart
turns and a half-played hole carries over to the player's next visit.

| Result | Points |
|---|---|
| 3 under par (albatross) | 5 |
| 2 under (eagle) | 4 |
| 1 under (birdie) | 3 |
| par | 2 |
| 1 over | 1 |
| worse — hole abandoned | 0 |

Handicap strokes are spread evenly and the remainder dealt from hole 1 upwards,
so a handicap of 20 gives two extra strokes on holes 1 and 2 and one everywhere
else. Playing every hole to personal par scores two points a hole — 36 over a
full round, which is exactly why a new player starts on a handicap of 36.

The handicap itself is **the best 8 of the last 20 rounds**, and a proportional
slice below that: the best single round up to five played, then one more for
every further two. Each round's verdict is `handicap + par target - points`, so
beating your handicap brings it down and playing to it leaves it alone. It is
computed from finished matches like every other statistic — never stored on the
profile — and is resolved into the match config at start time, so recomputing it
later cannot rewrite a round already played.

Adding a fifth game is one file in `packages/engine/src/` plus one line in
`registry.ts`.

### Ending a game early

**End game** stops the match where it stands, saves it, and awards it to whoever
is closest to winning. What "closest" means is the engine's decision: fewest
points left in X01, most in Gotcha, most targets closed in Cricket, most points
in Golf. Legs and sets already banked outrank progress in the current leg.

### Changing the roster mid-match

Players can join or leave a match in progress, from the **Players** button on the
play screen. Both are ordinary log commands, so they replay correctly through
undo and survive a restart. A joining player starts on their own full score; the
leg carries on. Removing whoever is currently throwing ends their turn cleanly.

## After the game

A match overview opens the moment a game ends — and from the **Last game**
button, which reads the most recently finished match. It shows the standings,
three-dart and first-nine averages, best turn, 180s, checkouts, busts, and the
full golf card hole by hole.

It also **replays the winning turn** dart by dart, and draws a **heatmap** of
where the darts landed, for everyone or for one player. The same heatmap for a
player's whole career is on their profile.

Heatmaps are built from segment counts, which scoring always knows, so they work
with `coords: null`. Where coordinates *are* reported — today the virtual board,
which knows exactly where it was clicked — individual darts are plotted on top.
Nothing depends on their presence; the map simply gets sharper when they arrive.

**Play again** starts a rematch with the same game, settings and players.
**Use last game's settings** on the setup screen loads them into the form
instead, so they can be adjusted first. Golf handicaps are deliberately *not*
carried over by either: they move with every round played, and reusing a stale
one would misprice the game.

## Players, statistics and achievements

Profiles are local records — name and colour, no accounts and no logins. Both are
editable at any time from the Players tab, and a rename flows through to historical
matches, because matches reference the profile rather than copying its name.
Deleting one soft-deletes, so its historical matches survive.

### The command log is the source of truth

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

Progress is written after every dart, so bars move during a match rather than
only when it ends, and every achievement declares its target statically so a
player who has never thrown still sees "0 / 10" rather than "0 / 1".

```bash
npm run achievements:backfill        # after adding an achievement
```

Achievements live in `packages/stats/src/achievements/catalogue.ts`, one entry
each. The same rebuild is available from the Settings page.

### Unlocks, celebrations and corrections

Achievements are evaluated **after every dart**, not at the final whistle, so an
unlock is celebrated the moment it happens and is persisted immediately — an
interrupted match does not lose it. Multiple unlocks queue rather than stack, so
a nine-darter shows each one in turn. The full-screen celebration honours
`prefers-reduced-motion` and can be turned off in Settings.

**Unlocks are a projection, not a fact.** Achievements are reconciled after every
command in both directions: undo a dart or correct it, and anything it earned is
withdrawn again. A celebration still on screen for a withdrawn achievement is
pulled. Without this, undo would leave a permanent reward behind and achievements
could be farmed by throwing and undoing.

Achievements earned in *earlier, finished* matches are never touched by an undo in
the current one.

Any achievement can also be **deleted** by hand from the player's gallery. There is
deliberately no "stays deleted" flag: since achievements are derived from the log,
one that is still earned will simply be awarded again. To remove one permanently,
correct the throw behind it — that changes the log, which is what the achievement
is computed from.

## Settings

Reachable from the Settings tab:

- **Celebrations** — on/off, and how long they stay on screen.
- **Dart coordinates** — enable coordinate-based achievements. Turning this on
  automatically runs a rebuild, which is what unlocks them retroactively.
- **Data** — rebuild all statistics and achievements from the command log.
- **Connection** — read-only view of the event source, board URL, bridge and
  database, so you can see what the bridge is attached to without reading
  compose files.

## Waiting on the throw payload

`packages/bridge/src/adapters/autodarts.ts` is the **only** file that knows
Autodarts field names. Everything else depends on `@darts/schema`.

Confirmed against the real board (see `recon/FINDINGS.md`): the transport, the
`{type, data}` envelope, the channel names and rates, and the full local control
API. Not yet confirmed: whether `coords` is `{x,y}` or `[x,y]`, its units and
origin, whether `segment` carries `number`/`multiplier`, and whether `throws[]`
is cumulative per turn.

Two rules keep that unknown contained:

- **`coords` is nullable and nothing depends on it.** Game logic, statistics and
  the scoreboard all work with `coords: null`. Achievements that would need
  coordinates are written but disabled behind `COORDS_ENABLED`; enabling that
  and running the backfill unlocks them retroactively.
- **The adapter parses strictly and fails loudly.** A silent mis-parse would
  produce a plausible-but-wrong score and quietly corrupt career statistics. An
  unexpected payload logs the offending frame and names the file to fix.

To capture the real payload:

```bash
./recon/capture-throws.sh 192.168.120.40
```

## Checks

```bash
npm run check      # typecheck (backend + frontend) and tests
npm test           # 257 tests, no hardware required
```
