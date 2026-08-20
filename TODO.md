# TODOs

- [x] add stableford mode, with handicap based on last 10 games
  - shipped as **Golf**, scored Stableford: holes 1-18 on the board's own
    numbers, par 4 plus handicap strokes, every dart a stroke
  - handicap is the best 8 of the last 20 rounds (a proportional slice below
    that), starting at 36
- [x] add highlighting for checkout/setup hints
  - the checkout route lights up on the board, brightest for the dart to throw
    now; golf lights the whole hole number
- [x] add a game overview after the game is finished, showing match stats
  - opens automatically when a match ends, and from the "Last game" button
  - includes a heatmap of where the darts landed on the board
  - averages, first nine, best turn, 180s, checkouts, busts, golf card
- [x] add a "last game" button to the main screen
  - plus "Use last game's settings" on the setup screen
- [x] add an "end game" button, ending a game should save the game and the
      player that is closest to winning should be treated as the winner
- [x] replay winning throw
  - the winning turn plays back dart by dart in the overview
- [x] heatmap per user throughout all games
  - in the player's panel, over every finished match
- [x] add a leaderboard for all players, showing their stats and ranking
  - its own tab, ranked on points: 3 for a win, 1 for turning up, so a season
    of showing up beats one lucky night
  - every column sorts; a row opens the player's heatmap, season detail and
    best golf card
  - averages, first nine, best turn, 180s, checkouts, busts, golf card
  - golf handicaps stay career-wide, because that is what the next round is
    played off
- [x] add start/stop, reset, calibrate buttons for the board, and a "board connected" indicator
  - on the play screen behind **Board**, and on the Settings page
  - each button is exactly one Board Manager endpoint, proxied through the
    bridge because that is the only process that knows the board's address
  - two indicators: the bridge heartbeat ("is it talking to us") and the
    board's own `running` flag ("is detection armed") — they differ
- [x] add a reset leaderboard button which clears the leaderboard and archives the current leaderboard
  - a reset deletes nothing: it files a condensed snapshot and records a
    timestamp, so a season is a window on the command log
  - the archive keeps the standings and how everyone threw; heatmaps and golf
    cards are left out, being derivable from the log
  - past leaderboards are listed under the table and reopen with a click


- [x] add Shanghai and Killer game modes
  - **Shanghai**: rounds 1-7 by default, only the round's own number scores,
    a single+double+triple of it in one turn wins instantly
  - **Killer**: claim a number, hit its double to become a killer, knock
    opponents' lives off with their doubles, last one standing wins
  - both reworked the "New match" player picker: a search box plus a pinned
    "selected" row and a scrollable list, so it stays usable with ~30 profiles
- [x] test the live board path without hardware
  - `@darts/fakeboard` speaks the Board Manager's local protocol on :3180, so
    `SOURCE=autodarts` runs end to end with no board and no cloud
  - covers reconnect, the stats heartbeat, the cumulative `throws[]` dedupe and
    takeout; drive it with `POST /sim/turn`, `/sim/throw`, `/sim/disconnect`
  - it emits the *inferred* throw payload, so it cannot close FINDINGS §3
- [ ] One thing worth knowing: tight-grouping and robin-hood still have stub evaluators (() => ({ unlocked: false })), so they now always appear in the achievement list as permanently locked. Wiring them to the real coordinate data is a separate piece of work