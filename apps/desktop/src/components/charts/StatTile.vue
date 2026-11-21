<script setup lang="ts">
/**
 * One reading with its name: the big number a first screen anchors on.
 *
 * A page that answers "how is this machine now" opens on a row of these. The value is the largest
 * type on the tile — the one big-size anchor the panels allow — wearing the tier `usageTone` names
 * when the reading is a usage, and the label above it stays the small tracked caps the panels
 * already speak. An optional series draws the reading's own recent history as a quiet band behind
 * the number: context for the eye, not a second chart to read, which is why the band never wears
 * the threshold colours — those are the number's to carry.
 *
 * The value arrives already formatted, unit and all — a bare number on a tile is a defect. A tile
 * with no reading shows the dash its caller sends, never a zero somebody would read as "idle".
 */
import { computed } from "vue";

import { TONE_TOKENS } from "./tone";

const props = withDefaults(
  defineProps<{
    /** What the number is of, already translated. */
    label: string;
    /** The reading, already formatted with its unit — or the dash when there is none. */
    value: string;
    /**
     * The tier the reading wears, from `usageTone`. A calm reading keeps the foreground, the way
     * the desk widgets' values already do: the tier colours are for the readings that need
     * watching, not for every number on the page.
     */
    tone?: "ok" | "warn" | "danger";
    /** The reading's own recent history, oldest first, for the band behind the number. */
    series?: readonly number[];
  }>(),
  { tone: undefined, series: undefined },
);

const colour = computed(() =>
  props.tone === "warn" ? TONE_TOKENS.warn : props.tone === "danger" ? TONE_TOKENS.danger : undefined,
);

/** The band's own scale: the tallest value it holds, or one, so an idle history still draws flat. */
const peak = computed(() => Math.max(1, ...(props.series ?? [])));

const band = computed(() => (props.series ?? []).map((value) => `${Math.round((value / peak.value) * 100)}%`));
</script>

<template>
  <div class="relative min-w-0 overflow-hidden rounded-md border border-border bg-card px-3 py-2">
    <div
      v-if="band.length > 1"
      class="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 opacity-20"
      aria-hidden="true"
    >
      <div class="flex h-full items-end gap-px">
        <span
          v-for="(height, index) in band"
          :key="index"
          class="min-w-0 flex-1 rounded-t-[1px] bg-muted-foreground"
          :style="{ height }"
        />
      </div>
    </div>
    <div class="relative">
      <p class="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{{ label }}</p>
      <p class="nums mt-1 text-xl font-semibold leading-none" :style="colour ? { color: colour } : undefined">
        {{ value }}
      </p>
    </div>
  </div>
</template>
