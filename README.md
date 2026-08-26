# open-darts

> [!IMPORTANT]
> This project is entirely AI-generated, since it was made as a small side project for our office dart board.
> We primarily built this for our own use, but we are happy to share it with the world. 
> Please note that this project should not be considered actively maintained, and we cannot guarantee its stability or security. Use at your own risk.
> If you do find any bugs however, feel free to report them!
> This project is in no way affiliated or endorsed by Autodarts.

A self-hosted darts game server and scoreboard built on Autodarts camera
hardware, using the Autodarts Board Manager purely as a **local detection
source**. No dependency on `api.autodarts.io` and no cloud game service.

## Status

Playable end to end, on real hardware or with a clickable virtual dartboard.
Switching between them is one environment variable, or a click on the Settings
screen.

The board's throw payload is understood, including the coordinate frame — see
[The anti-corruption boundary](#the-anti-corruption-boundary).

## Download and install

Windows and Linux builds are on the
[releases page](https://github.com/Muskoxen-Studios/opendarts/releases):

| Platform | File | Notes |
|---|---|---|
| Windows | `Darts-Setup-<version>.exe` | Installer; choose where it goes. |
| Linux | `Darts-<version>.AppImage` | `chmod +x` it and run it. |

The app updates itself: it checks the releases page on startup, downloads a new
version in the background, and offers to restart. "Check for updates" in the
**Darts** menu forces a check.

**Windows will warn you on first run.** The installer is not code-signed — that
needs a certificate that costs real money — so SmartScreen shows "Windows
protected your PC". Click **More info → Run anyway**. If you would rather not,
run it with Docker instead (below); nothing about the app differs.

Your games live in a database outside the app, so updating and uninstalling
never touch them:

| Platform | Database |
|---|---|
| Windows | `%APPDATA%\Darts\darts.db` |
| Linux | `~/.config/Darts/darts.db` |

**On the phone by the board too.** The app serves the same scoreboard to your
network. **Other devices** in the menu bar copies the address to open —
something like `http://192.168.0.12:8080`. Windows will ask to allow it through
the firewall the first time; it has to be allowed for this to work.

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
| `@darts/fakeboard` | A stand-in Board Manager, for testing without hardware. |
| `@darts/server` | Match state, profiles, persistence, WS + REST API. |
| `@darts/frontend` | Vue 3 scoreboard and virtual dartboard. |

Dependencies run one way: `schema <- engine <- stats <- server`. Nothing imports
the bridge; they talk over a websocket.

Node 24+ runs the TypeScript sources directly via type stripping, so the backend
has **no build step**. Persistence uses `node:sqlite`, built into Node, so there
is no native module to compile.

## Running it

The installer above is the easy path. To run it from source instead:

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

Or, as the desktop app does it — one window, both backends started for you:

```bash
npm run dev:desktop
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

## Games

**X01** — 301/501/701, straight/double/master in and out, legs and sets, bust
handling, and checkout hints. Out defaults to **straight**: this is a pub board,
and a leg that cannot be finished without a double is a leg that stops being
fun. Set out to `double` for match rules.

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

The handicap is always a **full-round figure**, so a shorter round is played off
a proportional share of it: nine holes off 36 is 18 strokes, the same two a hole
— and the same net par 6 — an eighteen-hole round gets. Spreading the whole 36
over nine would hand out four strokes a hole and make the short round twice as
easy as the number describing it.

The handicap is a **running figure carried on from the last round**, not an
average of past form: every ten points clear of the round's par target takes a
stroke off, every ten short puts one back on, any part of a ten counting as a
whole one — `-ceil(|points - par target| / step)` with the sign of the margin.
So 87 points off a full round is 51 clear and six strokes off, 10 points is 26
short and three strokes back on, and a round scored exactly on target leaves it
alone. Both halves of that sum scale with the length of the round: nine holes
are judged against a par target of 18 and a step of five points, so half a round
moves the handicap by exactly what the same standard of play would have moved it
over a whole one. Three good rounds in a row therefore compound rather than averaging out.
The current handicap is deliberately *not* in that sum: it already priced the
round, since a low handicap makes points harder to come by in the first place.
The base each round moves is the handicap actually played off, so a corrected
one is respected from then on, and the result is clamped to 0–36. It is
computed from finished matches like every other statistic — never stored on the
profile — and is resolved into the match config at start time, so recomputing it
later cannot rewrite a round already played.

**Shanghai** — rounds run from `startRound` to `endRound` (default 1–7), each
round's number the shared target that everyone plays before it advances. Only
darts on the round's own number score, at their ring value — a triple 3 in
round 3 is worth 9, everything else is worth nothing. Landing a single, a
double and a triple of the round's number in the same turn — "a Shanghai" — is
an instant win. Otherwise, whoever has the highest total after the last round
wins.

**Killer** — each player throws for a number of their own: the first dart to
land on an unclaimed 1–20 in any ring claims it, and anyone who finds nothing
in three darts is handed a random unclaimed number so no one gets stuck. Once
everyone has a number, play begins. Play is counted in *hits* — a dart's
multiplier on the number it lands in, so a single is one hit and a triple three.
A player becomes a killer on their third hit on their own number, in any ring
and across as many darts as it takes; once a killer, every hit on an opponent's
number costs that opponent a third of a life, so a triple takes a whole one. A
player at zero lives is eliminated and skipped for the rest of the match — last
player standing wins.

`friendlyFire` (off by default) makes hits on your own number cost you a third
of a life once you are already a killer, for groups who want the extra risk.
That includes the hits left over from the dart that crowned you: two doubles is
four hits, three to become a killer and one straight back at you.

Lives are held internally in thirds so that every re-fold of the command log is
integer arithmetic; only the scoreboard divides back into hearts, drawing the
one taking damage partly eaten.

### Manuals

Each game has a manual — its full rules — behind the **manual** button on the
setup screen, next to the game tabs. They are plain markdown files in
`packages/frontend/src/manuals/`, one per game type and named after it, pulled
into the bundle as raw text and rendered by the small markdown subset in
`packages/frontend/src/markdown.ts` (headings, lists, tables, code, quotes and
rules; everything escaped, since it goes through `v-html`). Editing a manual is
editing a document — nothing else needs wiring up, and a file left empty simply
reports that there is no manual yet.

Adding a new game is one file in `packages/engine/src/` plus one line in
`registry.ts`.

### Takeout ends the turn

A finished turn is not handed over the instant the third dart lands: the darts
are still in the board, so the scoreboard holds the player, their three darts
and their total until the board reports the takeout. That moment is what moves
the highlight on.

Pulling the darts out ends the turn **whatever the engine was still expecting**.
A dart that misses the board entirely is never detected, so the engine thinks a
dart is still owed — and before, the takeout did nothing at all and the turn sat
there until somebody pressed "end turn". The darts being out of the board is
physical proof the turn is over, so it is treated as one. The undetected dart is
simply recorded as never thrown, which shows up as a two-dart turn in the
statistics; correcting it is what the dart-correction control is for.

A takeout with nothing thrown is ignored, so tidying up between turns cannot
skip a player. Simulated and manually-entered darts have no physical takeout to
wait for and hand over immediately.

### The round limit

Every game takes an optional **round limit**, a cap on how long a single leg may
run. A round is a turn each — for everyone still in the leg, so it stays honest
when the rotation skips people, as X01 played to finishing places and Killer
after an elimination both do. Passing the limit ends the **leg** and hands it to
whoever is closest to winning, on exactly the same comparator "end game" uses
(see below). Legs and sets still decide the match, so a limit plus `legsToWin: 3`
gives three capped legs rather than one capped match.

Left empty it does nothing, which is the default. It exists for the games with no
natural end — Cricket, Gotcha and Killer can all run all night between evenly
matched players — but Golf and Shanghai take one too, where it acts as a ceiling
above their own holes and rounds rather than replacing them.

The round counter appears next to the leg and set in the scoreboard header, and
only when a limit is set: an uncapped leg has no round worth counting down.

```json
{ "gameType": "cricket", "variant": "standard", "roundLimit": 20 }
```

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

## The leaderboard

Every player, ranked, on its own tab. The order is by points — **3 for a win, 1
for turning up** — with win rate, then average, then legs won as tie-breaks.
Ranking on win rate alone would put whoever won their only match on top forever;
this way a season of showing up counts for something, and a single lucky night
does not.

The columns are the ones the match overview shows, over a whole season: three-dart
and first-nine averages, best turn, 180s, checkouts and the rate they were taken
at, busts, and the best Stableford round. Click a column to re-sort by it, and a
row to open the player's heatmap, their season detail and their best golf card
hole by hole.

Golf handicaps are the one figure that is **not** seasonal. A handicap is what
the next round is played off, so it is always computed from every round ever
played, even on a table that only counts the last month.

### Resetting it

**Reset leaderboard** files the current standings away and starts the table
empty. It deletes nothing:

- The archive keeps only the essential figures — the standings and how everyone
  threw. The heatmaps and golf cards are left out, because they are derivable
  from the command log, which the archive does not replace.
- The command log is untouched, so career statistics, achievements, match
  reports and profile heatmaps all carry on exactly as they were.
- A season is therefore just a *window* on the log: the reset records a
  timestamp, and the live table counts matches finished after it.

Past leaderboards stay listed under the table and reopen with a click.

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

Two of them read `coords`: **Tight Grouping** (three darts of one turn inside a
20 mm circle, measured as the smallest circle enclosing all three) and **Robin
Hood** (two darts of one turn landing within 5 mm of each other, a shaft's
width). Both compare darts *within a single turn only* — darts are pulled out
between turns — and a turn with any unlocated dart cannot unlock either.

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

## Controlling the board

Start and stop detection, reset the throw counter and re-run auto-calibration,
from the buttons in the app header, or the fuller panel on the Settings page.
They are in the header because Reset and Calibrate are wanted mid-game, with
darts in hand and the board misreading — not somewhere you have to go looking.
Each button is exactly one Board Manager endpoint and nothing more — stopping
detection stops darts arriving, it does not end the match.

The calls go frontend → server → bridge → board, because the bridge is the only
process that knows a board's address, and the board lives on the house network
rather than necessarily the one serving the UI. Unlike the throw payload, every
path used here is confirmed against real hardware (`recon/FINDINGS.md` §2).

Two indicators, answering different questions. The pill in the header is the
bridge's heartbeat — *is the board talking to us* — and shows the board's own
status word when it is. The chip on the Settings panel is the board's `running`
flag — *is detection actually armed*. A board can be perfectly online and
detecting nothing, and that is worth being able to see.

With the simulator or a replay as the source there is no board to control. The
buttons grey out and say why, rather than offering dead controls.

## Settings

Reachable from the Settings tab:

- **Celebrations** — on/off, and how long they stay on screen.
- **Bust & Gotcha burst** — how loud the dartboard gets when a turn busts or a
  knockback lands: *full* (shockwave and debris), *subtle* (flash and shake), or
  *off*. It fires under the dart that caused it. The label naming what happened
  sits on the board itself and shows at every setting, *off* included.
- **Data** — rebuild all statistics and achievements from the command log.
- **The board** — its own start, stop, reset and calibrate controls, plus a
  live connection indicator.
- **Connection** — read-only view of the event source, board URL, bridge and
  database, so you can see what the bridge is attached to without reading
  compose files.

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

Two rules keep the boundary worth having:

- **`coords` is nullable and nothing depends on it.** Game logic, statistics and
  the scoreboard all work with `coords: null`, because a dart's segment is
  enough to score it. Achievements that need coordinates simply evaluate to
  nothing for a dart without them.
- **The adapter parses strictly and fails loudly.** A silent mis-parse would
  produce a plausible-but-wrong score and quietly corrupt career statistics. An
  unexpected payload logs the offending frame and names the file to fix.

### The one that got through anyway

The coordinate frame was originally recorded as *y down*, and it was wrong. Every
board-sourced dart plotted mirrored top-to-bottom — a dart at 20 appeared at 3.

It survived because of how it was checked. Each captured dart landed at the
*radius* predicted for its segment, and a radius is identical under either sign
of y. The one dart whose angle was examined sat at 9 o'clock, where y ≈ 0 and
both conventions agree. Two darts in the upper right, both reported with
positive y, settle it — and that is what the round-trip test in
`packages/bridge/src/adapters/autodarts.test.ts` now asserts: every segment must
plot back inside its own wedge, by **angle**, not by radius.

The lesson, which is in `recon/FINDINGS.md` too: a radius cannot confirm an axis
direction.

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

Tagging `v*` builds both platforms on GitHub Actions and uploads them to a
**draft** release, so the notes can be written before anyone's app offers them
the update.

## Checks

```bash
npm run check      # typecheck (backend + frontend) and tests
npm test           # 361 tests, no hardware required
```
