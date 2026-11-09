# Minefield

Score points while turning the shared board into a minefield. First to reach or
pass the target (default **301**) wins the leg. Everyone starts at zero; scores
can go negative.

## Safe numbers

Every number 1–20 and bull starts with **3 HP**, adjustable from 1–9 in setup.
Every dart that hits a safe number scores normally, including doubles and
triples, and removes **one HP** regardless of ring. The dart that removes the
last HP still scores, then arms that number as a mine for everyone.

Both bull rings share one HP pool, numbered 25. Safe outer bulls score 25 and
inner bulls score 50. Misses score zero and do not affect the field.

## Explosions

Hitting an armed number subtracts its **base number** times the next multiplier,
without also earning points. The ring does not multiply the penalty again.

| Mine cycle for that number | Multiplier for all three blasts | Penalty per hit on 20 |
|---|---|---|
| First | 1× | −20 |
| Second | 1.5× | −30 |
| Third | 2× | −40 |
| Each later cycle | +0.5× | 10 more points per hit |

The multiplier stays fixed for all three explosions, even across turns and
players. Three hits on a newly armed 20 therefore cost **60 points total**.
After its third explosion, that number immediately resets to full HP. Once
those HP are used up again, it becomes a mine at **0.5× more** than before.
Other numbers are unchanged. Half-point scores are kept exactly: a second-cycle
bull blast costs 37.5 points, for example.

The escalation belongs to each number and is shared across players. You can
leave an armed number for an opponent or clear it to reopen a scoring target.
The dartboard shows HP badges on safe numbers. Armed wedges and both bull rings
**blink red**, with a mine icon and the current multiplier. The mine's tooltip
also shows its penalty and explosion count. With reduced motion enabled, mines
stay solid red. The overlays do not block dartboard clicks.

## Turns and matches

Three darts per turn, with the usual takeout before handover. Each new or
restarted leg resets all scores and the whole field. Legs and sets work as in
other modes. An optional round limit awards the leg to the highest score after
everyone has had the same number of turns; ties use seat order. Ending a match
early ranks sets, then legs, then current score.
