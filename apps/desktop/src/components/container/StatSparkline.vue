<script setup lang="ts">
/**
 * One short line of a series, as the Docker window draws them.
 *
 * The measure and the maths are `dockerMetrics`'s; this is the shell both the overview and a
 * single container's monitor draw — a titled panel with a polyline, no library and no animation,
 * because a live chart is data arriving rather than a transition. A series too young to draw says
 * so with the same dash the numbers use, rather than an empty box that could be mistaken for a
 * flat line.
 */
import { computed } from "vue";

import { SPARKLINE_HEIGHT, SPARKLINE_WIDTH, sparklinePoints } from "./dockerMetrics";

const props = withDefaults(
  defineProps<{
    /** The panel's title, already translated. */
    label: string;
    /** The series as sampled, oldest first. */
    values: readonly number[];
    /** Which of the window's three tones the line is drawn in. */
    tone?: "accent" | "success" | "warning";
    /** A reading shown beside the title, already formatted — the network rate, for one. */
    value?: string;
  }>(),
  { tone: "accent", value: undefined },
);

const points = computed(() => sparklinePoints(props.values, SPARKLINE_WIDTH, SPARKLINE_HEIGHT));

const STROKES: Record<"accent" | "success" | "warning", string> = {
  accent: "var(--workbench-accent)",
  success: "var(--success)",
  warning: "var(--warning)",
};
</script>

<template>
  <section class="rounded-md border border-border bg-card px-3 py-2.5">
    <h3
      class="mb-1.5 flex items-center justify-between text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
    >
      <span>{{ label }}</span>
      <span v-if="value !== undefined" class="font-mono text-[10px] normal-case">{{ value }}</span>
    </h3>
    <svg
      v-if="points !== ''"
      :viewBox="`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`"
      :width="SPARKLINE_WIDTH"
      :height="SPARKLINE_HEIGHT"
      role="img"
      :aria-label="label"
    >
      <polyline :points="points" fill="none" :stroke="STROKES[tone]" stroke-width="1.5" stroke-linejoin="round" />
    </svg>
    <p v-else class="text-[11px] text-muted-foreground">—</p>
  </section>
</template>
