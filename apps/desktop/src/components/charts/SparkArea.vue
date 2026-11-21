<script setup lang="ts">
/**
 * One short trend, as the container windows draw it: an area, not a bare line.
 *
 * The shape replaces the polyline the Docker window used to draw, and the change is the ruling the
 * chart vocabulary was built on: a bare line tells the eye the values between the samples were
 * measured, and they were not — the engine is sampled on a timer. The area keeps the trend legible
 * (the reference's own stat graph is an area) while the fill says what the line alone hid: this is
 * a band of samples, not a continuous reading.
 *
 * The measure and the maths are the chart layer's own (`areaPaths`); this is the shell both the
 * overview and a single container's monitor draw — a titled panel, no library and no animation,
 * because a live chart is data arriving rather than a transition. A series too young to draw says
 * so with the same dash the numbers use, rather than an empty box that could be mistaken for a
 * flat line.
 */
import { computed } from "vue";

import { areaPaths, SPARK_HEIGHT, SPARK_WIDTH } from "./areaPath";
import { TONE_TOKENS, type ChartTone } from "./tone";

const props = withDefaults(
  defineProps<{
    /** The panel's title, already translated. */
    label: string;
    /** The series as sampled, oldest first. */
    values: readonly number[];
    /** Which token the area is filled and stroked with; a usage reading names its tier. */
    tone?: ChartTone;
    /** A reading shown beside the title, already formatted — the network rate, for one. */
    value?: string;
  }>(),
  { tone: "accent", value: undefined },
);

const paths = computed(() => areaPaths(props.values, SPARK_WIDTH, SPARK_HEIGHT));

const token = computed(() => TONE_TOKENS[props.tone]);
</script>

<template>
  <section class="rounded-md border border-border bg-card px-3 py-2.5">
    <h3
      class="mb-1.5 flex items-center justify-between text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
    >
      <span>{{ label }}</span>
      <span v-if="value !== undefined" class="nums text-[10px] normal-case">{{ value }}</span>
    </h3>
    <svg
      v-if="paths !== null"
      :viewBox="`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`"
      :width="SPARK_WIDTH"
      :height="SPARK_HEIGHT"
      role="img"
      :aria-label="label"
    >
      <path :d="paths.area" :fill="token" fill-opacity="0.16" stroke="none" />
      <path :d="paths.line" fill="none" :stroke="token" stroke-width="1.5" stroke-linejoin="round" />
    </svg>
    <p v-else class="text-[11px] text-muted-foreground">—</p>
  </section>
</template>
