# Even/Odd

A race to a target score where **every dart counts against you as easily as
for you**. There is no number that is safe to hit — only ones that help and
ones that hurt.

## Scoring

Every dart moves your score. An **even** number **adds** its scored value —
ring multiplier included, so a single 6 is +6, a double 6 is +12, a triple 6
is +18. An **odd** number **subtracts** that same value. A miss changes
nothing.

The bulls are split the same way the numbers around them are: the **outer
bull (25)** is odd, so it subtracts 25. The **inner bull (50)** is even, so it
adds 50.

There is no floor — a bad turn can easily put you below zero, and you play on
from there.

## Winning

The first player to **reach or cross** the target score wins the leg
immediately, even mid-turn. A big double or triple on an even number can end
the leg on the spot; there is no need to finish the turn out.

## Why the config matters

`startingScore` sets where everyone begins — zero by default, but a negative
starting score makes for a longer, tighter race. `targetScore` is the finish
line: set it low for a short, swingy game where one good dart can decide it,
or high for a longer game where the lead changes hands more than once before
someone gets there.

## Scored as

The running score and how it moved each turn.
