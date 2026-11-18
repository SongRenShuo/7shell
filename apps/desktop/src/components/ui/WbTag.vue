<script setup lang="ts">
/**
 * A status tag: a state drawn as a pale wash of the colour it means, with the colour itself as the
 * text — the "light" combination fnOS draws its container states with.
 *
 * A state word on its own is data; a state word on its own colour is a thing a person scans. Four
 * tones: `success` for the running-and-healthy family, `danger` for the dead-and-failed family,
 * `warning` for the in-between ones, and `neutral` for the states that are neither good news nor a
 * problem — created, exited, whatever the engine reports that this build has not met yet. An
 * unknown state is the neutral tone, never a guess at a colour.
 *
 * The wash is mixed from the theme's own semantic colour, so a tag in a light theme and a tag in a
 * dark one read the same way without two palettes being maintained: the background is the meaning
 * colour at a low mix, the text the meaning colour at full strength.
 */
import { computed } from "vue";

import { cn } from "@/lib/utils";

export type WbTagTone = "success" | "danger" | "warning" | "neutral";

const TONE_VARS: Record<WbTagTone, string> = {
  success: "var(--success)",
  danger: "var(--destructive)",
  warning: "var(--warning)",
  neutral: "var(--muted-foreground)",
};

const props = withDefaults(
  defineProps<{
    /** What the state means, as one of the four tones. */
    tone?: WbTagTone;
  }>(),
  { tone: "neutral" },
);

const classes = computed(() => cn("wb-tag", `wb-tag--${props.tone}`));
const style = computed(() => ({ "--wb-tag-color": TONE_VARS[props.tone] }));
</script>

<template>
  <!--
    The pill is a span, not a badge: it is drawn inside table cells and summaries, where its own
    line is the wrong shape and its text must stay selectable with the row around it.
  -->
  <span :class="classes" :style="style" data-wb-tag>
    <slot />
  </span>
</template>

<style scoped>
.wb-tag {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 0.25rem;
  overflow: hidden;
  padding: 0 0.375rem;
  border-radius: calc(var(--radius) * 0.6);
  background: color-mix(in oklch, var(--wb-tag-color) 14%, transparent);
  color: var(--wb-tag-color);
  font-size: 11px;
  line-height: 1.5;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
