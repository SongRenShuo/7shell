<script setup lang="ts">
/**
 * The desk widgets' trend strip: one series, one thin row of bars.
 *
 * The widgets stand on the desk — on glass, on a picture — so their colours come from the
 * workbench family, not the theme's: the accent the running bars wear, or the muted step beside
 * it. A theme's semantic green on a pale wallpaper is exactly the colour that stops being visible,
 * which is the failure the fixed wallpaper-text pair exists to prevent.
 *
 * The strip is a bar row rather than a line for the reason the monitor's bars say better: the
 * samples arrive on a timer, and a line would claim the space between them was measured.
 *
 * An empty history keeps the strip's height so the card does not jump when the first sample lands,
 * and nothing is drawn for it — an empty strip is not a flat line at zero.
 */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    /** The series as sampled, oldest first. */
    values: readonly number[];
    /** What the strip shows, for a reader who cannot see it. */
    label: string;
    /** Which workbench token the bars wear. */
    tone?: "accent" | "muted";
    /** How tall the row is. */
    heightClass?: string;
  }>(),
  { tone: "accent", heightClass: "h-6" },
);

/** The two workbench tokens the strip can wear, both of the on-picture family. */
const TOKENS = {
  accent: "var(--workbench-accent)",
  muted: "var(--workbench-on-picture-muted)",
} as const;

/** The tallest value the strip holds, or one, so an idle series draws a flat row, not nothing. */
const peak = computed(() => Math.max(1, ...props.values));

function height(value: number): string {
  return `${Math.round((value / peak.value) * 100)}%`;
}
</script>

<template>
  <div class="flex items-end gap-px" :class="heightClass" role="img" :aria-label="label">
    <span
      v-for="(value, index) in values"
      :key="index"
      class="min-w-0 flex-1 rounded-t-[1px]"
      :style="{ height: height(value), background: TOKENS[tone] }"
    />
  </div>
</template>
