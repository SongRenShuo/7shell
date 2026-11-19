<script setup lang="ts">
/**
 * The desktop's button, and the Docker window's button: one shape, four intents, three sizes.
 *
 * The desktop chrome had no button of its own — every pane wrote its own classes, and two panes
 * two rows apart carried two slightly different buttons. This is the shared shape, dressed the
 * Semi way: `primary` is the brand blue the desktop's accent token carries, `secondary` the white
 * face with an edge, `tertiary` the ones that are only a wash and words on a bar, and `warn` the
 * destructive-adjacent ones — the light wash of the danger colour with the danger colour itself as
 * the text, the combination that says "careful" without shouting. Three sizes at the reference's
 * own heights — 28px, 36px, 40px — and the control radius the design system names (6px, the
 * interface's `rounded-sm`, still derived from the corner style).
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
  // The base: an inline-flex so an icon and a word sit on one line, the control radius the corner
  // style derives, the focus ring the rest of the interface draws, and the transitions the
  // desktop's motion tokens name.
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-sm border select-none transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60",
  {
    variants: {
      variant: {
        primary:
          "border-transparent bg-[var(--workbench-accent)] text-[var(--workbench-on-wallpaper)] hover:bg-[color-mix(in_srgb,var(--workbench-accent)_88%,var(--workbench-on-wallpaper))] disabled:hover:bg-[var(--workbench-accent)]",
        secondary: "border-border bg-background text-foreground hover:bg-accent disabled:hover:bg-background",
        tertiary: "border-transparent bg-muted text-foreground hover:bg-accent disabled:hover:bg-muted",
        warn: "border-[color-mix(in_srgb,var(--workbench-danger)_40%,transparent)] bg-[color-mix(in_srgb,var(--workbench-danger)_10%,transparent)] text-[var(--workbench-danger)] hover:bg-[color-mix(in_srgb,var(--workbench-danger)_18%,transparent)] disabled:hover:bg-[color-mix(in_srgb,var(--workbench-danger)_10%,transparent)]",
      },
      size: {
        sm: "h-7 gap-1 px-2 text-[11px]",
        md: "h-9 px-3 text-xs",
        lg: "h-10 px-3.5 text-sm",
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
/** The spinner steps with the button: the small control carries the small one. */
const spinnerSize = computed(() => (props.size === "sm" ? 12 : 14));
</script>

<template>
  <!-- type="button": a button inside a form is never a submit unless somebody asked for one. -->
  <button type="button" :class="classes" :disabled="inert" :aria-busy="busy || undefined">
    <LoaderCircle v-if="busy" :size="spinnerSize" class="shrink-0 animate-spin" aria-hidden="true" />
    <slot />
  </button>
</template>
