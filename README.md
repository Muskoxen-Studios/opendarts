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

An experimental **native image detector and simulated camera rig** can now run
without Autodarts or a physical board. This is a planar-marker proof-of-pipeline,
not yet a replacement for real-hardware dart detection; see
[Native detection and simulated cameras](#native-detection-and-simulated-cameras).

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
| `native` | Our experimental local image detector at `DETECTOR_URL` (default `http://127.0.0.1:8091`). |
| `replay` | Replays a recorded capture from `REPLAY_FILE`. |

Simulated darts are posted to the **bridge**, not straight into the game server,
so they travel the same path real darts will.

### Native detection and simulated cameras

Requires **Python 3.10+** as well as Node 24+. No Python packages, camera permissions,
cloud service, or Autodarts installation are needed for this development path.
Start these in separate terminals:

```sh
npm run dev:detector
SOURCE=native DETECTOR_URL=http://127.0.0.1:8091 npm run dev:bridge
npm run dev:server
npm run dev:frontend
```

In **Settings → Dart source**, select **Native detector**, test the local URL,
and apply it. A stored source choice overrides the bridge environment on server
reconnect, so explicitly apply native if you previously saved another source.
The camera diagnostics panel shows the three synthetic views and controls for
adding an impact in millimetres (x right, y up), removing some/all darts, and
resetting the simulated scene. Start a match before adding darts. Wait for an
adopted baseline, stable frames and `Throw` between impacts. The default
`x=0, y=102` is T20; use separated coordinates for subsequent darts rather than
putting two invisible-overlapping markers at the same point.

**This tests images, not injected scores.** The simulator renders grayscale
frames; the detector differences them against the empty reference, extracts tip
silhouettes, reconciles measured coordinates across calibrated views, and waits
for temporal stability. Only then does it score the impact and send our own
board events through the bridge and server. Synthetic coordinates and expected
segments are not given to the detector. Native mode rejects virtual-board
segment injection; use the camera simulator controls instead.

The third dart holds the turn until image-observed full takeout. Partial removal
does not advance the player. Reset adopts the current occupancy without emitting
throws or a takeout. Native throws disable legacy "a new throw proves missed
takeout" recovery: a fourth visible dart cannot advance the player by itself.
Missing/ambiguous views and uncertain near-wire impacts fail closed, with a
reset-required review fault rather than a guessed score. Clear the scene and
reconcile the match manually before resetting after uncertainty.

Validation and deterministic image replay:

```sh
npm run test:detector
npm run test:native     # real Python → bridge → server, temporary DB, no hardware
npm run check:native   # TypeScript checks/tests + Python tests + native smoke
python3 services/detector/main.py --source replay --replay testdata/vision/sequence.json
```

Camera previews use same-origin allowlisted server/bridge proxies. The detector
binds only to loopback; remote phones view it through the existing server. Like
other game controls, the proxies are not authenticated: use a trusted LAN and
do not expose the server publicly. The detector is an independently started
process, **not bundled in the desktop installer or Docker services yet**.

The browser also offers a **3D camera rig** with actual dart meshes and calibrated
perspective views. Development desktop launch manages its rendered Python service;
Python is still not bundled in installers.

Rendered cameras default to **1280×720** (16:9), with a provisional **100° horizontal
FOV** converted exactly to vertical FOV by
`2 * atan(tan(100° / 2) * 720 / 1280)` (about **67.67°**). Vertical FOV remains
adjustable; the rig retains radius 260 mm, forward offset 220 mm and rotation 60°.
Camera module listings give inconsistent viewing angles; this is not a measured
lens calibration. Actual hardware needs intrinsic/lens calibration, including distortion.
The narrower vertical view may crop the outer board. Overview and previews also use
16:9 without stretching. Inputs remain full-resolution top-down grayscale, not color
detection or downsampled previews. Three raw base64 frames occupy about 3.69 MB of
JSON; only render configure/frames allow 6 MiB through server, bridge and detector.
Reset retains a 4096-byte cap. Synthetic defaults and 640×480 replay compatibility
are unchanged. 720p has three times the pixels of 640×480: pure-Python processing,
readback, encoding, uploads and bounded capture copies may increase latency; no
real-time throughput or accuracy claim is made.

The original synthetic/replay source
uses planar markers. An offline labelled rendered suite and resumable Python tuner
are available via `npm run detector:generate`, `detector:evaluate`, and
`detector:tune`; see the detector README for complete commands. Labels never enter
the detector, images are cached once, and tuning never changes active parameters.

In the rendered-source panel, click the overview board to place the next configured
3D dart; drag to orbit without placing. Placement obeys the same acknowledged-frame,
stability, session, fault and takeout guards as the insert button. Green rings mark
actual board entries, pink rings show the latest pixel-only reconstruction, and amber
rings show its uncertainty radius. These annotations exist only on overview layer 1;
none enters the three grayscale camera inputs. Nearest-tip errors are comparisons,
not dart identity assignments or scoring receipts. Actual and reconstructed tips also show
coordinate-derived segment labels/points using schema board geometry; a reconstructed
T20 does **not** mean the detector accepted T20. Raw diagnostics remain available.

Rendered uncertainty uses the propagated pixel/shaft-angle error with a **1 mm
minimum radius**, rather than adding a further 1 mm to that error. An impact still
requires its entire uncertainty disk to stay within one scoring bed. Diagnostics
expose the radius components; offline evaluation reports measured errors against
the bounds, including otherwise eligible scoring rejections. This is an empirical
guard checked on simulated pixels, not calibrated hardware confidence. Existing
parameter files retain their shaft-refinement decisions; code changes invalidate
older tuning checkpoints, so reevaluate their candidates before further tuning.

The dart's `(x, y, 0)` is the **axis/board entry**, still the target for reconstruction,
labels and scoring, not the buried physical apex. **Axial penetration** is measured
along the tilted dart axis (default 8 mm; omitted legacy values also use 8 mm).
The physical apex is `entry - penetration × unitAxis`; board-normal burial is
`penetration × unitAxis.z`. Point length now means total physical length, unchanged
at 10–45 mm; penetration is 0–20 mm and must leave at least 2 mm before the barrel.
Zero restores the exposed apex. Buried dart material is clipped at the board plane;
existing length/width limits and the 217 mm maximum axial envelope are not enlarged.
Board number labels, like comparison overlays, are overview-only layer 1.

The board already had raised round wires. Their shared mesh/placement model uses
schema scoring radii and all 20 wedge boundaries, with representative 0.55 mm wire
radius and 0.6 mm centre height—not measured hardware dimensions. Optional
**successful-entry wire-clear placement** conservatively rejects the tilted steel
point footprint across the raised-wire slab, including wire endpoints, with an
explicit message and no snapping. It applies to click, insert and preview presets.
Bulls and the physical miss surround are allowed beds; wedge wires stop at the outer
double. Unchecked **unrestricted** mode permits wire-overlapping stress scenes.
This is a geometric placement filter, not a guarantee of physical entry: it does
not model dart collisions, deformation, material properties or bounce-outs.
Wire-bounce scenarios are deferred.

Rendering changes invalidate version-2/3 image benchmarks: scenario/cache version
is now 4, with 1280×720 images and the explicit 100° horizontal baseline replacing
the benchmark’s custom 95° vertical FOV, plus explicit 8 mm axial penetration and deliberately unrestricted
near-wire cases. Generate into a new output directory only when requested; old
cached images remain historical artifacts. Previous tuned parameters and benchmark
results require reevaluation on newly rendered pixels before reuse or promotion.
No dataset generation, retuning or parameter promotion happens automatically.

**Reset playground** explicitly stops the old upload session, clears all scene darts,
and configures the existing rendered service with an empty reference. It does not
undo match scores or emit takeout: reconcile the match manually first. It requires
the upload-risk acknowledgement and a running rendered source; fresh session,
stability and acknowledgement guards still apply. There is no automatic reset/rearm.
A detector rejection intentionally stops uploads. Its original reason stays visible;
a later `stream stalled` diagnostic is secondary to that stop, not a replacement
explanation. Stop uploads also intentionally produces a later stale stream.
Frame receipt is independent of shaft processing, allowing the browser to keep
uploading while a slow frame is analyzed. A full six-batch queue waits up to
2.5 seconds for space before rejecting; it never drops or automatically resends
pending frames to make room. A genuine absence of uploads still trips the three-second stream
watchdog. Switching tabs pauses diagnostics and disarms rendered uploads, so a
later stall after leaving the simulator or stopping it is expected.

**Export first failure JSON** downloads an offline, versioned capture, frozen at the
first fault until explicitly discarded (even across reset). It contains the exact
submitted configure payload including empty camera references, a recent window of
submitted grayscale batches, per-batch scene darts/rig as separate offline truth,
and the state/diagnostics available at the fault. Labels are never sent to the
detector. The window is bounded to 16 batches / 24 MiB, configuration to 8 MiB,
state metadata to 256 KiB; oversized entries are omitted. Image/configuration
budgets conservatively count two bytes per JSON character; at 720p the window
usually retains only three full batches, not sixteen. This is browser memory
only, cleared on panel teardown, with no automatic disk persistence. Review images
and diagnostics before sharing the user-initiated download.

The JSON supplies camera matrices/references and image batches for offline replay;
it is not the existing benchmark dataset format or an automatic replay importer.
Polling does not bind diagnostics to a submitted frame sequence, so the capture
cannot prove which frame was rejected or accepted. Submission is not acceptance.
Parameter/build provenance is unknown unless exposed in existing state diagnostics;
no parameter file is fetched or inferred and no match history is exported.

**Rendered uploads are not match-isolated.** Accepted detections score the active
match, and image-observed takeout can advance its turn. Enabling uploads requires
acknowledging this warning. Use a disposable match (which still affects history/stats)
or a separate server/database for experiments. Scene-only preview uploads nothing;
stopping uploads or closing the panel does not request takeout.

To see a reviewed tuning candidate in this panel, export the plain
`selected.parameters` object and evaluate the held-out split using the commands in
[`services/detector/README.md`](services/detector/README.md#offline-rendered-evaluation-and-tuning).
Stop the existing detector, including any desktop-managed process, then explicitly
start it from the repository root:

```sh
python3 services/detector/main.py --source rendered --parameters build/rendered-benchmark/candidate.json --port 8091
```

Use the browser development bridge/server/frontend stack, apply **Native detector**
with URL `http://127.0.0.1:8091`, start detection, and enable uploads in the rendered
panel. Do not launch a second detector on the same port. This startup flag accepts a
validated plain, possibly partial parameter object—not the enclosing tuning artifact.
Omitting it uses defaults; the panel never loads or promotes a candidate automatically.

**Limitations:** perspective detection remains experimental and rejects many
rendered cases; the benchmark has also exposed wrong acceptance. There is no USB
acquisition, automatic hardware/lens calibration, hand classifier, robust
live-video stability model or hardware accuracy claim.
Autodarts remains the supported real-board source. See
[`services/detector/README.md`](services/detector/README.md) for the protocol,
replay format, safety behaviour and prerequisites for hardware use.

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

**X01** — 170/301/501/701, straight/double/master in and out, legs and sets, bust
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

The live Cricket table has one column per player, with names, avatars and large
point totals above target rows 20–15 and Bull. Avatars sit beside the score at
the score's height, as on the X01 player cards. Empty cells are blank; one mark
is a slash, two a cross and three a circled cross on green. The current thrower
is highlighted, with MPR, darts and sets/legs in the column header when space
allows. It replaces the separate player strip and score card. Larger rosters
scroll horizontally while target labels stay visible on the left.

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

Empty dart slots preview the target for each remaining throw, accounting for
the strokes left before a hole is abandoned. With one attempt left on hole 5,
a fresh turn shows `5, 6, 6`. Hitting a hole early updates the remaining hints:
hit 5 then 6 and the final slot suggests 7.

With voice announcements enabled, the caller says “Target 1” at the start and
announces each new target after a hit or an abandoned hole while darts remain.
After the third dart it waits for the player switch, then announces the incoming
player's target, even if it is the same number. Calls follow the active player's
actual hole and use the same speech queue as scores and misses.

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

**Even/Odd** — every dart moves your score: an **even** number adds its scored
value, ring multiplier included (a double 6 is +12, a triple 6 is +18), and an
**odd** number subtracts it. A miss does nothing. Bulls are split like any
other pair of numbers next to each other on the board — the **outer bull (25)**
is odd and subtracts 25, the **inner bull (50)** is even and adds 50. Scores
can go negative; there is no floor. The first player to reach or cross
`targetScore` wins the leg outright, mid-turn if that is what it takes.

`startingScore` (default 0) is every player's score at the start of a leg, and
can itself be negative for a harder start. `targetScore` (default 100) is the
finish line: the higher it is, the longer the game runs and the more a run of
odd numbers can be clawed back before someone reaches it.

**Minefield** — shared HP, mines and optional blast zones on numbers 1–20 and
bull (25). Safe darts score normally and remove one HP each; the final HP hit
still scores before arming the number. Choose normal count-up (default target
301) or Gotcha, including exact finishes, overshoot busts and zero/previous-turn
knockbacks. A bust restores turn-start score while physical board changes and
earlier knockbacks remain, matching ordinary Gotcha scoring.

HP is configurable as **X per player** (`hitPoints: null`,
`hitPointsPerPlayer`, default 2) or **X total** (`hitPoints`). There is no extra
floor or cap; values are nonnegative whole counts, with zero starting armed.
Per-player totals are resolved at the start of each leg and remain fixed until
a new or restarted leg. Existing explicit total HP values are preserved.

`mineLifetime` counts explosions before a hazard clears, default 1. The last
explosion restores full HP and raises that field's next mine multiplier by
0.5×; the multiplier stays fixed throughout a lifetime. Normal penalties use the
base number times its multiplier, rounded to whole points, halves up. A 1.5×
bull costs 38, never 37.5. `defusal` (default on) lets doubles, triples and inner
bull clear the whole hazard, score normally and keep its multiplier unchanged.
Turn it off to have all rings trigger hazards.

`blastRadius` (default off) makes direct mine hits reset the player's score to
zero and creates normal-penalty blast zones on the two neighbouring wedges in
physical board order: a mine on 20 covers 1 and 5, initially costing 1 and 5.
`resetNegative` controls whether a direct mine also raises a negative score to
zero; off leaves negative scores unchanged while still consuming an explosion.
Bull has no radius and is never a zone. When the hit hazard exhausts its
configured lifetime, the whole mine and its two blast-zone fields explode:
all regain full HP and each multiplier rises by 0.5×. Hitting a blast zone
triggers its source mine (or both sources in an overlap). Any active mine
caught in the explosion also explodes with its own radius, chaining through
adjacent mines. Only the field actually hit affects the player's score;
collateral explosions add no penalties. Direct mines take precedence over zones.
Overlaps do not stack damage or replenish lifetime. Defusal still clears only
the hit hazard; removing a source removes its radius, preserving zones covered
by another source.

The board shows red mine badges (→0 for score-reset mines), amber blast-zone
penalties and safe HP. Tooltips include remaining lifetime and defusal rules.
Actual explosions animate at the hit segment with fireball, smoke, waves and
sparks; defusal uses a separate green effect. Effects settings and reduced
motion are respected. New legs, restarts, undo and correction replay account
for all shared hazards and Gotcha scores. See the setup manual for full rules.

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

### The live match screen

During play, the header collapses to a compact bar with board status, board
controls and the Awake indicator visible. The free space in this bar contains
Undo, End turn, Correct last dart, Players, End game and Last game. **Menu**
expands navigation over the match and hides these match actions while open;
closing it brings them back. Other tabs retain the full header.

On desktop screens, the live match uses the full available width at natural
text size. Match actions use the header, turn notices and recent darts share the
row above the roster, and the main area has just scores on the left and the
dartboard on the right. The board fits the remaining height instead of making
the entire match shrink as its column grows taller.
Unusually long scorecards scroll within their own panel, leaving the roster,
controls and board readable. The comparison at 1366×768 and 1920×1080 includes
two, four and eight players, long names and multiple game modes.

The screen reflows for portrait phones and retains scaling as a fallback for
small windows, rotation and unusual content. All roster cards remain visible.
Player management opens separately, as do match results, so those panels can
scroll without shrinking the match underneath.

Turn notices and the recent-dart history reserve their space, so showing
“remove your darts”, a stuck-takeout action, or correction help does not resize
the match.

While a match is playing, the visible app requests a **screen wake lock** and
reacquires it when you return to the tab. It releases the lock when the match
ends or the page is hidden. The header shows **Awake** when the request succeeds;
the menu explains when it is unavailable and offers a retry if it was released
or declined. Browsers require HTTPS or localhost for this API. A phone opening
a plain HTTP LAN address must use its own screen-timeout setting, or access the
app through HTTPS. Battery-saving settings can also decline or release a lock.

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

The results dashboard highlights the winner and each player's performance, with
game-specific cards for X01 averages and checkouts, Cricket marks, and Golf
Stableford points, birdies and the round target. Golf also shows each player's
handicap **before → after**, alongside the actual change after the 0–36 limits
are applied. This is the change earned by that match, even when viewing an old
round. A round with no completed holes leaves the handicap unchanged.

Live results are delivered directly when the match finishes, before career
statistics are rebuilt. Achievement celebrations become compact notifications
while the overview is open, so a queue of unlocks cannot hide the results.

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

Profiles are local records — name, colour and an optional email address, no accounts
and no logins. Edit these details from the Players tab; clear the email field to
remove it. When an email has a Gravatar, its avatar appears beside the player name
throughout the app. Gravatar requests use a hash of the trimmed, lowercase email;
images load through the server and missing images or offline lookups leave names
visible without an avatar. No Gravatar account is required to play.
Outside Cricket's table, player fields show the name above the score with an
avatar spanning the field's content height on the left. The current player's
card shows a large avatar beside the score, with the score aligned to the right.
A rename flows through to historical
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

Finishing a match updates its throws, the participants' career totals and their
achievements using cached history. It does not replay and backfill every past
match, so the results screen is not followed by a full rebuild that blocks
starting the next game.

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

- **Sounds & voice** — opt-in spoken turn totals, misses, busts and leg/match wins,
  plus X01 checkout requirements when a player comes to the oche with a legal
  checkout route. Gotcha knockbacks say “Gotcha!” instead of a sound effect or
  confirmation knock. Separate sound effects cover busts (shattering glass), wins
  and Minefield explosions, with a shared volume slider and test button. Mine
  and blast-zone hits play a short booming explosion; a chain plays one burst.
  Exploding throws skip the confirmation knock and spoken turn score.
  With sound effects enabled, each registered throw that is neither a miss nor
  a bust also gets a short, dull knock like a dart hitting the board. This plays immediately, even
  during commentary, so missing feedback can flag a lost board connection.
  Preferences are saved per browser; both switches default to off. Speech uses
  the system's English voice (availability depends on the browser and installed
  voices). Click or press a key in the app to allow playback. Hidden tabs stay
  silent; reconnecting, undoing or correcting darts does not replay old calls.
  Calls omit player names and play in order, waiting for each announcement to
  finish even when the simulator immediately advances the turn. An idle audio
  output gets a one-second lead-in before playback; effects finish before speech.
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

### Releases from GitHub

[Release Please](https://github.com/googleapis/release-please) maintains a release
PR after changes land on `master`. Use Conventional Commit titles when squash
merging PRs: `fix: ...` for a patch, `feat: ...` for a minor version, and
`feat!: ...` for a major version. Other titles such as `docs: ...` and `ci: ...`
do not trigger a release by themselves. The initial version is 0.4.2.

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
npm test           # 361 tests, no hardware required
```
