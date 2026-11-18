<script lang="ts">
/**
 * The five scenes an empty surface can name, adopted from the reference's feedback set (its Empty
 * ships five illustrations — NoData, LoadFailed, NoFile, NoHardDisk, NoSearchResult — in three
 * sizes). Here each scene is one line drawing, not a pair: the reference draws a dark and a light
 * SVG for every scene, but the strokes below are `currentColor` and the one decorative touch is a
 * token, so the light and the dark version are the same paths under different colours and there is
 * nothing to keep in step.
 *
 * The component draws and says nothing on its own: the title and the description are handed in
 * already translated, the way the desktop's other base pieces take their labels, so this file
 * imports no translations and the caller decides what an empty trash versus an empty mirror list
 * is called. Colour is inherited, not chosen — the caller sets the text colour its context
 * deserves (the interface's muted tone on a theme surface, the desktop's on-picture token inside
 * a window on a wallpaper).
 */

/** The scene the drawing tells. */
export type WbEmptyScenario = "noData" | "loadFailed" | "noFile" | "noHardDisk" | "noSearchResult";

/** The drawing's three sizes, the reference's own 48 / 100 / 150px tiers. */
export type WbEmptySize = "sm" | "md" | "lg";

/** The pixel size each named tier draws at. */
export const WB_EMPTY_SIZES: Readonly<Record<WbEmptySize, number>> = { sm: 48, md: 100, lg: 150 };

/** Every scene this build draws, so callers can iterate the set. */
export const WB_EMPTY_SCENARIOS: readonly WbEmptyScenario[] = [
  "noData",
  "loadFailed",
  "noFile",
  "noHardDisk",
  "noSearchResult",
];
</script>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    /** Which empty this is; the drawing follows. */
    scenario: WbEmptyScenario;
    /** sm for a table row, md for a panel, lg for a page. */
    size?: WbEmptySize;
    /** The one line above the drawing, already translated. */
    title?: string;
    /** The line under it, already translated. */
    description?: string;
  }>(),
  { size: "md", title: undefined, description: undefined },
);

const pixel = computed(() => WB_EMPTY_SIZES[props.size]);
</script>

<template>
  <figure
    class="flex flex-col items-center justify-center gap-3 text-center"
    data-wb-empty
    :data-scenario="scenario"
    :data-size="size"
  >
    <!-- One 100x100 drawing per scene, strokes in the inherited colour, the small flourish in the
         desktop's accent token. `stroke-linecap` and `stroke-linejoin` are the line-work the rest
         of the interface's lucide icons draw with. -->
    <svg
      :width="pixel"
      :height="pixel"
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
      class="shrink-0"
      data-wb-empty-art
    >
      <g
        v-if="scenario === 'noData'"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M26 52v26h48V52" />
        <path d="M26 52l-8-7M74 52l8-7" opacity="0.55" />
        <circle cx="50" cy="34" r="7" stroke-dasharray="3 4" />
        <path d="M50 14v8M62 18l-4 6M38 18l4 6" opacity="0.55" stroke-dasharray="2 4" />
      </g>

      <g
        v-else-if="scenario === 'loadFailed'"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M34 18h26l12 12v52H34z" />
        <path d="M60 18v12h12" opacity="0.55" />
        <path d="M45 50l14 14M59 50l-14 14" />
        <circle cx="67" cy="36" r="2.5" stroke="none" fill="var(--workbench-accent, currentColor)" />
      </g>

      <g
        v-else-if="scenario === 'noFile'"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M24 34h18l7 8h27v34H24z" />
        <path d="M36 54h30M36 62h22" stroke-dasharray="3 4" opacity="0.7" />
        <circle cx="70" cy="30" r="2.5" stroke="none" fill="var(--workbench-accent, currentColor)" />
      </g>

      <g
        v-else-if="scenario === 'noHardDisk'"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <ellipse cx="50" cy="33" rx="25" ry="9" />
        <path d="M25 33v32c0 5 11 9 25 9s25-4 25-9V33" />
        <path d="M38 52h24" stroke-dasharray="3 4" opacity="0.7" />
        <circle cx="68" cy="22" r="2.5" stroke="none" fill="var(--workbench-accent, currentColor)" />
      </g>

      <g v-else stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M28 20h34l12 12v48H28z" stroke-dasharray="4 4" opacity="0.6" />
        <circle cx="52" cy="50" r="13" />
        <path d="M61 60l12 12" />
        <circle cx="52" cy="50" r="2" stroke="none" fill="var(--workbench-accent, currentColor)" />
      </g>
    </svg>

    <figcaption v-if="title !== undefined || description !== undefined" class="flex flex-col gap-1">
      <p v-if="title !== undefined" data-wb-empty-title class="text-sm">{{ title }}</p>
      <p v-if="description !== undefined" data-wb-empty-description class="text-xs opacity-65">
        {{ description }}
      </p>
    </figcaption>
  </figure>
</template>
