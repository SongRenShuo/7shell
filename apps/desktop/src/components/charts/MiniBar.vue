<script setup lang="ts">
/**
 * A table row's capacity bar: how full one thing is, at the width a cell can spare.
 *
 * The tier is the desktops' own — `usageTone` names it, the theme's tokens paint it — so a column
 * of these reads green, amber and red on the same cuts every other gauge on the desktop answers
 * to. There is no prop for a private threshold, because a column that out-shouts the gauges beside
 * it is not being more precise, only louder.
 *
 * A row with no reading draws the dash the numbers use, never an empty bar that could be mistaken
 * for an empty disk.
 */
import { computed } from "vue";

import { TONE_TOKENS, usageTone } from "./tone";

const props = defineProps<{
  /** How full, as a percent; a reading that never arrived sends null. */
  percent: number | null;
  /** What the bar is of, for a reader who cannot see it. */
  label?: string;
}>();

const width = computed(() => `${Math.min(Math.max(props.percent ?? 0, 0), 100)}%`);

const fill = computed(() => (props.percent === null ? undefined : TONE_TOKENS[usageTone(props.percent)]));
</script>

<template>
  <span
    v-if="percent !== null"
    class="block h-1.5 w-full min-w-0 overflow-hidden rounded-sm bg-muted"
    :role="label ? 'img' : undefined"
    :aria-label="label ?? undefined"
  >
    <span class="block h-full rounded-sm" :style="{ width, background: fill }" />
  </span>
  <span v-else class="text-[11px] text-muted-foreground">—</span>
</template>
