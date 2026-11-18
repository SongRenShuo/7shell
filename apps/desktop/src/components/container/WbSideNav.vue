<script setup lang="ts">
/**
 * The desktop Docker window's left navigation: the 220px rail fnOS's Docker manager keeps, drawn
 * for this window rather than shared with the application's flat workspace.
 *
 * It is presentational. What the pages are, what counts they carry and which of them the session
 * can open right now are decided by the pane that hands the items over — the pane is where "the
 * engine is not connected" is known, and that is why the disabled item exists: the pane shows only
 * the overview then, and this rail draws that truth rather than enforcing it.
 *
 * The badge is a count, not an alarm: a number that outgrows its pill is clipped to
 * `overflowCount` with a plus, because "thirty-nine" in a nav rail is noise and "10+" still says
 * "more than the rail has room to say". fnOS clips the same way.
 */
import type { Component } from "vue";
import { computed } from "vue";

import { cn } from "@/lib/utils";

export interface SideNavItem {
  /** The page this row opens, named the way the pane's own switch names them. */
  readonly id: string;
  readonly label: string;
  readonly icon: Component;
  /** The total drawn in the badge; null draws no badge at all. */
  readonly count?: number | null;
  /** Drawn dimmed and refusing presses, for a page the session cannot open yet. */
  readonly disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    items: readonly SideNavItem[];
    /** Which page is on screen. */
    activeId: string;
    /** The rail's accessible name. */
    label: string;
    /** Where a count is clipped to "N+". */
    overflowCount?: number;
  }>(),
  { overflowCount: 10 },
);

const emit = defineEmits<{ select: [id: string] }>();

/** The badge's text: the count, or the clipped "N+" once the count outgrows the rail. */
function badgeText(item: SideNavItem): string | null {
  const count = item.count;
  if (count === null || count === undefined) {
    return null;
  }
  return count > props.overflowCount ? `${props.overflowCount}+` : String(count);
}

const itemClass = computed(
  () =>
    (item: SideNavItem): string =>
      cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs transition-colors",
        item.disabled && "cursor-not-allowed text-muted-foreground/60",
        !item.disabled && item.id === props.activeId
          ? "bg-accent text-foreground shadow-[inset_3px_0_0_var(--workbench-accent)]"
          : !item.disabled
            ? "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            : "",
      ),
);
</script>

<template>
  <aside class="flex w-[220px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-1.5">
    <nav :aria-label="props.label" class="flex flex-col gap-0.5">
      <button
        v-for="item in props.items"
        :key="item.id"
        type="button"
        :class="itemClass(item)"
        :aria-current="item.id === props.activeId ? 'page' : undefined"
        :aria-disabled="item.disabled || undefined"
        :data-side-nav-item="item.id"
        @click="!item.disabled && emit('select', item.id)"
      >
        <component :is="item.icon" :size="14" class="shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate text-left">{{ item.label }}</span>
        <span
          v-if="badgeText(item) !== null"
          data-side-nav-badge
          class="shrink-0 rounded-full bg-accent px-1.5 font-mono text-[10px] leading-4 text-accent-foreground"
        >
          {{ badgeText(item) }}
        </span>
      </button>
    </nav>
  </aside>
</template>
