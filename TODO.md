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
- [ ] add a leaderboard for all players, showing their stats and ranking
  - includes a heatmap of where the darts landed on the board
  - averages, first nine, best turn, 180s, checkouts, busts, golf card
- [ ] add start/stop, reset, calibrate buttons for the board, and a "board connected" indicator. they can directly call the board's api
- [ ] add a reset leaderboard button which clears all stats besides the top three players.


## Ideas not yet picked up

- Coordinates only exist for simulator darts. Once the board's throw payload is
  captured the same heatmaps sharpen automatically, with no code change here.
- Golf assumes a hole is holed by hitting the number in any ring. A stricter
  "must hit the double" variant would be a config flag on the same engine.
