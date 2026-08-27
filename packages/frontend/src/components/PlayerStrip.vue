<script setup lang="ts">
import { computed, nextTick, watch } from 'vue';
import {
  gotcha,
  heartFill,
  isOut,
  killer,
  ordinal,
  placeOf,
  type View,
} from '../gameDetail.ts';

const props = defineProps<{ view: View }>();

const isKiller = computed(() => props.view.gameType === 'killer');
const isGotcha = computed(() => props.view.gameType === 'gotcha');

/**
 * Killer is played against everyone else's number and lives; Gotcha against
 * everyone else's position in the race. In those two games the strip is not a
 * courtesy, it is the board you aim by -- so it wraps to fit the whole roster
 * instead of scrolling most of it out of sight.
 */
const everyoneMatters = computed(() => isKiller.value || isGotcha.value);

/** Keeps the strip scrolled to the player currently throwing. */
const miniEls = new Map<string, HTMLElement>();
function setMiniEl(playerId: string, el: Element | null): void {
  if (el) miniEls.set(playerId, el as HTMLElement);
  else miniEls.delete(playerId);
}

watch(
  () => props.view.activePlayerId,
  async (playerId) => {
    // Nothing to scroll when the strip wraps -- and scrollIntoView would jog
    // the page instead of the strip.
    if (!playerId || everyoneMatters.value) return;
    await nextTick();
    miniEls.get(playerId)?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  },
  { immediate: true },
);
</script>

<template>
  <div class="strip" :class="{ wrap: everyoneMatters, slim: everyoneMatters }">
    <article v-for="p in view.players" :key="p.playerId" :ref="(el) => setMiniEl(p.playerId, el as Element | null)"
      class="mini" :class="{ active: p.isActive, winner: view.winnerId === p.playerId, out: isOut(p, view.gameType) }"
      :style="{ '--accent': p.color }">
      <!--
        Killer is played against everyone else's number, lives and killer
        status, so all of that has to be visible here too -- not just for
        whoever is throwing. The number takes the big slot other games use
        for the score; lives are hearts, same idea as the big card's, plus
        a knife the moment a player becomes a killer.
      -->
      <template v-if="isKiller">
        <span class="mini-score">
          <template v-if="killer(p).eliminated">OUT</template>
          <template v-else-if="killer(p).number === null">?</template>
          <template v-else>{{ killer(p).number }}</template>
        </span>
        <span class="mini-lives">
          <span v-for="i in killer(p).startingLives" :key="i" class="life"
            :style="{ '--fill': heartFill(p, i) }" />
        </span>
      </template>
      <!--
        Gotcha counts up to a target, so the score is the number that moves --
        but what you actually judge an opponent by is how far they still have
        to go. Both, the gap small underneath.
      -->
      <template v-else-if="isGotcha">
        <span class="mini-score">{{ p.score }}</span>
        <span class="mini-togo">{{ gotcha(p).remaining }} to go</span>
      </template>
      <span v-else class="mini-score">{{ p.score }}</span>
      <div>
        <span class="mini-name">{{ p.name }}</span>
        <span v-if="killer(p).isKiller" class="mini-knife" title="Killer">&#x1F52A;</span>
      </div>
      <span v-if="placeOf(p)" class="mini-place">{{ ordinal(placeOf(p)!) }}</span>
    </article>
  </div>
</template>

<style scoped>
/*
 * Everyone, small, in turn order, across the full width of the window -- this
 * sits above the play grid rather than inside its left column, because the
 * roster is the one thing every game needs room for.
 *
 * "Small" is relative: these are sized to be read from the oche, several
 * metres away. That is why the type here is larger than the usual
 * secondary-text scale.
 *
 * By default a big roster costs width, not height: the strip scrolls
 * horizontally and stays centred on whoever is throwing (see the
 * activePlayerId watcher). Killer and Gotcha invert that trade via `.wrap` --
 * there you have to see every player at once, and height is the cheap
 * resource, since only the thrower gets a big card below.
 */
.strip {
  /* The heart silhouette the life pips are masked with. */
  --heart:
    url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z' fill='black'/%3E%3C/svg%3E");
  display: flex;
  gap: 0.7rem;
  overflow-x: auto;
  padding: 0.15rem;
  scroll-behavior: smooth;
  /*
   * No scrollbar: nobody drags this from the oche, it scrolls itself to
   * whoever is throwing. The bar would only eat height under the cards.
   */
  scrollbar-width: none;
}

.strip::-webkit-scrollbar {
  display: none;
}

.strip.wrap {
  flex-wrap: wrap;
  justify-content: center;
  overflow-x: visible;
}

.mini {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.1rem;
  min-width: 9.5rem;
  border: 1px solid #262b33;
  border-top: 3px solid var(--accent);
  border-radius: 8px;
  padding: 0.75rem 1.1rem;
  background: #14171c;
  transition: background 120ms ease, border-color 120ms ease;
}

/*
 * The 9.5rem floor is paid for by the name, not the number -- "20" at 3.4rem
 * is barely 4rem wide. Where the whole roster has to fit, the name gives up
 * its width and ellipsises; every number and heart keeps its size.
 */
.strip.slim .mini {
  min-width: 7rem;
  padding: 0.75rem 0.7rem;
}

.strip.slim .mini-name {
  display: inline-block;
  max-width: 7.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
}

.mini.active {
  background: #1b2029;
  box-shadow: 0 0 0 2px var(--accent);
}

.mini.winner {
  box-shadow: 0 0 0 2px #3f9d54 inset;
}

.mini.out {
  opacity: 0.62;
}

.mini-score {
  font-size: 3.4rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.mini-name {
  font-size: 1.4rem;
  color: #8b93a1;
  white-space: nowrap;
}

.mini-place {
  font-size: 1.15rem;
  font-weight: 700;
  color: #e0b84a;
  text-transform: uppercase;
}

.mini-togo {
  font-size: 1.15rem;
  font-weight: 700;
  color: #8b94a3;
  font-variant-numeric: tabular-nums;
}

.mini-lives {
  display: flex;
  align-items: center;
  gap: 0.2rem;
  font-size: 1.6rem;
}

.mini-lives .life {
  /* Slightly tighter than the surrounding text, which is sized for the score. */
  font-size: 1.2rem;
}

.mini-knife {
  font-size: 1.5rem;
  margin-left: 0.1rem;
}

/*
  A heart is a box masked into the heart shape and filled left-to-right by a
  hard-stop gradient, so a third of a life lost reads as a third of a heart
  eaten. Drawn rather than typed: the text glyph renders as a colour emoji on
  some systems, where neither `color` nor a clipped overlay does anything.
*/
.life {
  display: inline-block;
  width: 1em;
  height: 1em;
  background: linear-gradient(90deg, #d8453f var(--fill, 100%), #333a45 var(--fill, 100%));
  -webkit-mask: var(--heart) center / contain no-repeat;
  mask: var(--heart) center / contain no-repeat;
}
</style>
