# Playing and player data

For a feature overview, see the [README](../README.md). Full game rules are available in the setup screen’s **manual** button and in the [game manuals](../packages/frontend/src/manuals/).

## Match setup

In the setup screen's **Players** section, **Use last game's players** selects
the last finished game's lineup in its original order while keeping the game and
rules currently chosen. Deleted profiles are skipped. **Shuffle players** randomly
reorders the selected lineup; numbered chips show the resulting throwing order.
Drag the selected players by their handles to change the order with a mouse or
touch, or focus a handle and use the arrow keys. Separate × buttons remove players.
Shuffling requires at least two selected players and preserves their handicaps.

## The live match screen

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
controls and board readable.
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
dart is still owed. Taking out the darts ends the turn even if fewer than three
darts were detected. The undetected dart is
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

Conquest fixes its starting roster for territory placement and does not allow late
joins. See its [manual](../packages/frontend/src/manuals/conquest.md) for departure rules.

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
with `coords: null`. Where coordinates are reported, individual darts are plotted on top.
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
