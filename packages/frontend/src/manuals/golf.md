# Golf

Eighteen holes on the board's own numbers: hole 1 is the 1, hole 7 the 7, hole
18 the 18. The goal is to hit each hole in as few darts as possible, and to
collect as many points as you can doing it. Play rotates in ordinary three-dart
turns.

The handicap is what lets players of very different standards play the same round
on level terms — and what lets one player play alone, against nothing but their
own handicap.

## A hole

Every dart is a stroke. The hole is holed the moment you hit its number **in any
ring** — single, double and treble all count — and you move straight on to the
next number, with whatever darts are left in your turn.

You also move on without holing it once you are **over your net par without a
hit**: there is nothing left to score there, so the hole is abandoned for
nothing. A half-played hole carries over to your next visit.

**Net par = 4 strokes, plus your proportional share of your handicap.**

## Points

Points are scored on the number of strokes the hole took, against your own net
par:

| Result | Strokes | Points |
|---|---|---|
| Albatross | 3 or more under net par | 5 |
| Eagle | 2 under | 4 |
| Birdie | 1 under | 3 |
| Par | net par | 2 |
| Bogey | 1 over | 1 |
| Double bogey | 2 or more over — hole abandoned | 0 |

## Your handicap

A new player starts on a personal handicap of **36**.

The handicap is divided over the holes and added to par as whole extra strokes,
evenly, with the remainder dealt out from hole 1 upwards. So a handicap of 36
over 18 holes is two extra strokes on every hole: net par 6 everywhere.

That newcomer therefore has six darts at each hole — four from par, two from the
handicap — to make par and its 2 points. Holing it in five is a birdie for 3,
in four an eagle for 4, and so on.

Playing every hole to your own net par is 2 points a hole: **36 over a full
round**, which is exactly why a new player starts on 36.

### Example

Adam plays off 27. Spread over 18 holes that is one stroke everywhere with nine
left over, dealt from hole 1 up — so he gets two extra strokes on holes 1 to 9
and one on holes 10 to 18. Net par 6 on the front nine, net par 5 on the back
nine.

A 9-hole round works the same way, on the first nine numbers, with the handicap
spread over nine holes instead of eighteen.

## Improving your handicap

Your handicap is recorded and moves with your play: rounds under par bring it
down, rounds over par push it back up, and a round played exactly to it leaves it
alone.

It is read from your recent form rather than from your last round alone — the
best 8 of your last 20 rounds, or a proportional slice of that while you have
fewer behind you. Each round is valued at `handicap + par target - points`,
clamped to 0–36, where the par target is 2 points a hole so 9- and 18-hole
rounds stay comparable.

The number is worked out from your finished rounds and never stored against your
profile, but it is fixed into the match when the round starts — so a handicap
recomputed later can never rewrite a round already played. It is shown, and can
be overridden, on the setup screen before the first dart.
