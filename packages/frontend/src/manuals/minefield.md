# Minefield

Score points while turning the shared board into a minefield. First to reach or
pass the target (default **301**) wins the leg. Everyone starts at zero; scores
can go negative.

## Safe numbers

Every number 1–20 and bull starts with **3 HP per player, with a minimum of 6**:
6 HP for one or two players, 9 for three, 12 for four. Setup scales this
automatically, or you can choose a manual HP value of at least 6. HP is fixed
for the leg; players joining or leaving affect automatic HP when the next leg
starts or the current leg is restarted.
Every dart that hits a safe number scores normally, including doubles and
triples, and removes **one HP** regardless of ring. The dart that removes the
last HP still scores, then arms that number as a mine for everyone.

Both bull rings share one HP pool, numbered 25. Safe outer bulls score 25 and
inner bulls score 50. Misses score zero and do not affect the field.

## Explosions

Hitting an armed number **explodes it once and immediately restores its full
HP**. That dart subtracts the **base number** times the current multiplier,
rounded to the nearest whole point, with halves rounded up. It does not also
earn points, and the ring does not multiply the penalty again. Later darts can
score on the restored number normally.

| Mine cycle for that number | Multiplier | Penalty per hit on 20 |
|---|---|---|
| First | 1× | −20 |
| Second | 1.5× | −30 |
| Third | 2× | −40 |
| Each later cycle | +0.5× | 10 more points per hit |

Each explosion raises that number's next mine multiplier by **0.5×**, but it
must lose all its restored HP before becoming a mine again. If you hit an armed
20 three times in one turn, the first hit costs 20 and immediately resets it;
the following two single hits score 20 each, for a net **+20** that turn.

There are **no half points**: a second-cycle bull explosion costs **38 points**
(25 × 1.5 = 37.5, rounded up); a 19 at 1.5× costs **29**. Round each dart's
penalty before subtracting it. Other numbers are unchanged.

The escalation belongs to each number and is shared across players. You can
leave an armed number for an opponent or clear it to reopen a scoring target.
The dartboard shows HP badges on safe numbers. Armed wedges and both bull rings
**blink red**, with a mine icon and the current multiplier. The mine's tooltip
also shows its whole-point penalty and that it resets on hit. With reduced motion enabled, mines
stay solid red. The overlays do not block dartboard clicks.

## Turns and matches

Three darts per turn, with the usual takeout before handover. Each new or
restarted leg resets all scores and the whole field. Legs and sets work as in
other modes. An optional round limit awards the leg to the highest score after
everyone has had the same number of turns; ties use seat order. Ending a match
early ranks sets, then legs, then current score.
