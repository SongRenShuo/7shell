<script setup lang="ts">
/**
 * The desktop's button, and the Docker window's button: one shape, three intents, two sizes.
 *
 * The desktop chrome had no button of its own — every pane wrote its own classes, and two panes
 * two rows apart carried two slightly different buttons. This is the shared shape: `primary` for
 * the action the pane exists to offer, `secondary` for the ordinary ones beside it, `ghost` for
 * the ones that are only icons and words on a bar. Two sizes, because the desktop's chrome works
 * at 11px text and its window contents at 12px, and both are sizes the interface already ships.
 *
 * `busy` is the loading state the write actions share: the button stops accepting presses and
 * turns its label over to whoever is rendering it — the caller shows the operation's own words
 * (starting, pulling, removing) through the normal slot, because a spinner alone says "something"
 * where a person needs to know "what".
 *
 * Styling reads the theme tokens like every other surface: a button drawn inside a window follows
 * the window's theme. The chrome that stands on the wallpaper does not use this component — it
 * keeps its own on-picture styling.
 */
import { LoaderCircle } from "@lucide/vue";
import { cva, type VariantProps } from "class-variance-authority";
import { computed } from "vue";

import { cn } from "@/lib/utils";

const variants = cva(
  // The base: an inline-flex so an icon and a word sit on one line, the focus ring the rest of the
  // interface draws, and the transitions the desktop's motion tokens name.
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border select-none transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60",
  {
    variants: {
      variant: {
        primary: "border-transparent bg-primary text-primary-foreground hover:bg-primary/90 disabled:hover:bg-primary",
        secondary: "border-border text-foreground hover:bg-accent disabled:hover:bg-transparent",
        ghost: "border-transparent text-foreground hover:bg-accent disabled:hover:bg-transparent",
      },
      size: {
        sm: "h-6 gap-1 rounded-[var(--wb-radius-content)] px-2 text-[11px]",
        md: "h-7 px-3 text-xs",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "md",
    },
  },
);

const props = withDefaults(
  defineProps<{
    /** What kind of action this is. */
    variant?: NonNullable<VariantProps<typeof variants>["variant"]>;
    /** How much room it takes. */
    size?: NonNullable<VariantProps<typeof variants>["size"]>;
    /** Draws the spinner and refuses presses while an operation is in flight. */
    busy?: boolean;
    /** Native disabled: dimmed and inert, without the spinner. */
    disabled?: boolean;
  }>(),
  {
    variant: undefined,
    size: undefined,
    busy: false,
    disabled: false,
  },
);

const inert = computed(() => props.busy || props.disabled);
const classes = computed(() => cn(variants({ variant: props.variant, size: props.size })));
</script>

<template>
  <!-- type="button": a button inside a form is never a submit unless somebody asked for one. -->
  <button type="button" :class="classes" :disabled="inert" :aria-busy="busy || undefined">
    <LoaderCircle v-if="busy" :size="12" class="shrink-0 animate-spin" aria-hidden="true" />
    <slot />
  </button>
</template>
