<script setup lang="ts">
/**
 * One ring saying how full something is.
 *
 * The system panel's disk rings used to be an inline SVG with one threshold — past ninety the arc
 * went straight to red, so ninety-four and ninety-nine wore the same colour and the amber step the
 * desktops share was missing. The gauge draws the arc in the tier `usageTone` names: below ninety
 * the theme's success token, ninety to ninety-four the warning one, ninety-five and past it the
 * destructive one. No gauge may keep its own cuts; there is no prop for one.
 *
 * A subject that answered nothing sends `null`, and the gauge draws the track alone: an empty arc
 * is not a reading of zero, and the caption beside the ring carries whatever numbers exist.
 */
import { computed } from "vue";

import { TONE_TOKENS, usageTone } from "./tone";

/** The ring's own geometry: a 44px tile, a 4px stroke, the radius the panel has always drawn. */
const RADIUS = 18;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const props = defineProps<{
  /** How full, as a percent; a subject that answered nothing sends null. */
  percent: number | null;
  /**
   * What the ring is, for a reader who cannot see it. Given, the ring is a labelled image; absent
   * it hides itself from the reader, because the caption beside it already says both the subject
   * and the numbers.
   */
  label?: string;
}>();

const dash = computed(() => {
  if (props.percent === null) {
    return null;
  }
  const drawn = (Math.min(Math.max(props.percent, 0), 100) / 100) * CIRCUMFERENCE;
  return `${drawn.toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`;
});

const stroke = computed(() => (props.percent === null ? undefined : TONE_TOKENS[usageTone(props.percent)]));
</script>

<template>
  <svg
    viewBox="0 0 44 44"
    class="size-11 -rotate-90"
    :role="label ? 'img' : undefined"
    :aria-label="label ?? undefined"
    :aria-hidden="label ? undefined : 'true'"
  >
    <circle cx="22" cy="22" :r="RADIUS" fill="none" stroke="var(--accent)" stroke-width="4" />
    <circle
      v-if="dash !== null"
      cx="22"
      cy="22"
      :r="RADIUS"
      fill="none"
      :stroke="stroke"
      stroke-width="4"
      stroke-linecap="round"
      :stroke-dasharray="dash"
    />
  </svg>
</template>
