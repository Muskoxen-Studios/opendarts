# Minefield

Everyone shares a changing board of mines. Start at zero and race to the target
(default **301**). Scores may go negative, but there are **no half points**.

## Scoring mode

- **Normal:** reach or pass the target to win.
- **Gotcha:** landing on an opponent's positive total knocks them back, either
  to zero or their previous-turn score. Exact finishing is on by default;
  overshooting restores your turn-start score and ends your turn. Turn off
  exact finishing to allow reaching or passing the target instead.

A bust restores your score, not the physical board: hits still wear down HP,
use up hazard lifetime, and can clear or arm fields. Earlier knockbacks stand,
as in the ordinary Gotcha mode. Mine and blast-zone penalties can also land on
an opponent's positive total and trigger a knockback.

## Hit points

Choose **X per player** or **X total per number**. The default is **2 per player**,
with no extra floor or cap. Values are whole HP counts; **zero** starts every
field armed. The total is fixed for the leg, including all hazard resets.
Players joining or leaving affect per-player HP on the next new or restarted
leg, so the live board does not unexpectedly resize.

Numbers 1–20 and bull each have their own HP. A safe hit scores normally and
removes **one HP per dart**, regardless of ring. The hit that removes the final
HP still scores, then arms that number as a mine for everyone.

Both bull rings share the 25 field. Safe outer bulls score 25; inner bulls
score 50. Misses score zero and leave the board alone.

## Mine lifetime and penalties

**Mine lifetime** is the number of explosions before that hazard clears. The
default is **1**. Every explosion during one lifetime uses the same multiplier.
When the last explosion clears the hazard, the field regains full HP and its
next multiplier rises by **0.5×**: 1×, 1.5×, 2×, and so on. It must lose its HP
again before the next mine cycle. At zero HP a cleared field immediately rearms.

Without blast radius, a mine costs its base number times its multiplier,
without an extra double/triple ring multiplier. Round each penalty to the
nearest whole point **before subtraction**, with halves rounded up. A 1.5×
bull costs **38** and a 1.5× 19 costs **29**. With lifetime 1, hitting an armed
20 and then two single 20s gives −20, +20, +20: a net **+20** turn.

## Blast radius

Turn this on for two effects:

- A **direct hit on a mine resets the thrower's score to zero** instead of
  subtracting a normal penalty. By default, a negative score is left unchanged;
  enable **Direct mines also reset negative scores** to raise it to zero too.
  The explosion still uses a lifetime hit either way.
- The mine's immediately adjacent wedges become **blast zones**, using physical
  board order. A mine on **20** covers **1 and 5**. A blast-zone hit subtracts
  that number times its own multiplier: initially **−1 or −5**.

Bull has no neighbours and never becomes a blast zone; a bull mine still has
the direct score-reset effect.

When the hit field uses its last lifetime hit, **the whole mine and both blast
zones explode together**. All three fields regain full HP and their multipliers
rise by 0.5×. Hitting a blast zone triggers its source mine; if two mines cover
the hit zone, both explode. An active mine caught in an explosion also explodes
with its own two neighbours, so adjacent mines cause a chain reaction.

**Only the field your dart hit affects your score.** Other fields exploding
add no penalties or score resets. A field that is itself a mine takes
precedence over a blast zone and resets the score. Overlapping zones do not
stack penalties or refill lifetime.

## Defusal

**Allow double/triple defusal** is on by default and can be switched off.
When enabled, a double or triple on a mine **or blast zone** safely clears its
entire remaining lifetime, scores normally, restores HP and leaves the
multiplier unchanged. Inner bull counts as a double; outer bull explodes.
Defusing a direct mine also clears its remaining radius.

When defusal is off, doubles, triples and inner bulls trigger the same hazard
as a single; the ring does not multiply a penalty again.

## On the board

Safe badges show HP. **Red mines** show their multiplier, or **→0** when blast
radius is on. **Amber blast zones** show the whole-point penalty. Tooltips and
accessible labels describe the hazard, remaining explosions and defusal rules.
Mines blink red; blast zones pulse amber. Reduced motion keeps their fills steady.

An explosion produces a fireball, smoke, shockwaves and sparks at the hit field,
with a score-change banner. Defusal has a separate green effect and does not
shake the board. Effects settings and reduced-motion preferences are respected;
the result label remains visible even when decorative effects are off.

## Turns and matches

Three darts per turn, with the usual takeout before handover. New or restarted
legs reset scores, HP, multipliers and zones. Legs and sets work as in other
modes. A round limit awards the leg to the highest score after everyone has had
the same number of turns; ties use seat order. Ending a match early ranks sets,
then legs, then current score. Undo and corrections rebuild the shared field,
lifetimes, knockbacks and scores from the command log.
