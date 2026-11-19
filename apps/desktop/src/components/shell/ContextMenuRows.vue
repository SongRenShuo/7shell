<script setup lang="ts">
/**
 * One level of an open menu: the rows, and nothing about where they are drawn.
 *
 * The layer above draws this twice — once for the menu and once for the submenu that a row opened —
 * because the two lists are made of exactly the same things, and a second copy of this markup would
 * be a second place for the two to drift apart.
 *
 * A row's id is its level's prefix and its own id, which the layer above recomputes to point
 * `aria-activedescendant` at the row the keyboard is on. `ContextMenu.spec.ts` asks for the row that
 * attribute names, so a formula that stopped matching fails there rather than quietly announcing
 * nothing.
 */
import { Check, ChevronRight } from "@lucide/vue";
import type { Component } from "vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import type { MenuTone } from "@/composables/useContextMenu";
import type { MenuEntry } from "@/lib/menu/types";
import { formatShortcutDisplay } from "@/lib/shortcuts/display";
import { bindingFor } from "@/lib/shortcuts/registry";
import { useAppStore } from "@/stores/app";
import { usePreferencesStore } from "@/stores/preferences";
import { cn } from "@/lib/utils";

const props = defineProps<{
  entries: readonly MenuEntry[];
  /** What this level's row ids start with: the same string the layer above uses for its active id. */
  prefix: string;
  /** Which row the keyboard is on. -1 while the level has just opened and nothing is chosen. */
  active: number;
  /** The sheet the rows sit on; the row colours follow it rather than the interface's palette. */
  tone: MenuTone;
}>();

/**
 * On the desktop's Semi dropdown sheet the rows follow the menu's own face — the host's theme, not
 * the wallpaper — so their colours come from the `--workbench-menu-*` tokens rather than from the
 * on-picture remap; on the application card they follow the interface's tokens.
 */
const onDesktop = computed(() => props.tone === "desktop");

/** The hairline between groups: the border colour on the card, the menu's own on the dropdown. */
const separatorClass = computed(() => (onDesktop.value ? "bg-[var(--workbench-menu-separator)]" : "bg-border"));

/** Where a row's icon (or its tick) sits, and the colour it is drawn in. */
const slotClass = computed(() =>
  onDesktop.value ? "text-[var(--workbench-menu-text-muted)]" : "text-muted-foreground",
);

/** A key or a submenu arrow: quieter than the label, on either sheet. */
const quietClass = computed(() =>
  onDesktop.value ? "text-[var(--workbench-menu-text-muted)]" : "text-muted-foreground",
);

/** One row's colours, keeping the one thing the tone does not change: danger reads as danger. */
function rowClass(entry: MenuEntry, index: number): string {
  const disabled = !usable(entry);
  const dangerous = entry.kind === "action" && entry.danger === true;
  const lit = props.active === index && !disabled;
  if (disabled) {
    return onDesktop.value
      ? "cursor-not-allowed text-[var(--workbench-menu-text-muted)]"
      : "cursor-not-allowed text-muted-foreground/50";
  }
  if (dangerous) {
    return onDesktop.value
      ? cn(
          "text-[var(--semi-color-danger)]",
          lit ? "bg-[var(--semi-color-danger-light-default)]" : "hover:bg-[var(--semi-color-danger-light-hover)]",
        )
      : cn("text-destructive", lit ? "bg-destructive/10" : "hover:bg-destructive/10");
  }
  return onDesktop.value
    ? cn(
        "text-[var(--workbench-menu-text)]",
        lit ? "bg-[var(--semi-color-primary-light-default)]" : "hover:bg-[var(--workbench-menu-hover)]",
      )
    : cn("hover:bg-accent hover:text-accent-foreground", lit ? "bg-accent" : undefined);
}

const emit = defineEmits<{
  (event: "hover", index: number, entry: MenuEntry): void;
  (event: "activate", index: number, entry: MenuEntry): void;
}>();

const { t } = useI18n();
const app = useAppStore();
const preferences = usePreferencesStore();

/**
 * The key a row prints, spelled for the platform it is drawn on.
 *
 * An entry carries a binding (`Mod+V`) rather than a sentence, because the same key reads `Ctrl + V`
 * on one platform and `⌘ V` on another — a menu that said Ctrl on a Mac would be advertising a key
 * that does nothing there.
 */
function accelFor(entry: MenuEntry): string {
  if (entry.kind !== "action" || entry.shortcut === undefined) {
    return "";
  }
  // The key in force, not the one the menu was written with: the settings decide what an action
  // answers to, and a row that printed its own idea of it would be advertising a key that does
  // nothing.
  return formatShortcutDisplay(bindingFor(entry.shortcut, preferences.keybindings), app.platform);
}

function rowId(entry: MenuEntry): string {
  return `${props.prefix}-${entry.id}`;
}

/** Whether the keyboard can land on this row, which is also when it is drawn as usable. */
function usable(entry: MenuEntry): boolean {
  if (entry.kind === "separator") {
    return false;
  }
  return entry.kind === "submenu" || entry.disabled !== true;
}

/** The icon to draw, or nothing: a row that is a choice draws its tick in the same slot instead. */
function iconFor(entry: MenuEntry): Component | undefined {
  if (entry.kind === "separator" || (entry.kind === "action" && entry.checked !== undefined)) {
    return undefined;
  }
  return entry.icon;
}
</script>

<template>
  <template v-for="(entry, index) in entries" :key="entry.id">
    <div v-if="entry.kind === 'separator'" role="separator" class="my-1 h-px" :class="separatorClass"></div>
    <button
      v-else
      :id="rowId(entry)"
      type="button"
      :role="entry.kind === 'action' && entry.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'"
      :aria-checked="entry.kind === 'action' && entry.checked !== undefined ? entry.checked : undefined"
      :aria-haspopup="entry.kind === 'submenu' ? 'menu' : undefined"
      :disabled="entry.kind === 'action' && entry.disabled === true"
      :aria-disabled="entry.kind === 'action' && entry.disabled === true ? 'true' : undefined"
      :class="
        cn('flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors', rowClass(entry, index))
      "
      @mousemove="emit('hover', index, entry)"
      @click="emit('activate', index, entry)"
    >
      <!--
        The icon sits in a slot that is there whether or not an icon is. A row that is a choice draws
        the tick in it instead of an icon, so what the switch is set to is readable at a glance and
        the labels stay in one column.
      -->
      <span class="grid size-3 shrink-0 place-items-center" :class="slotClass">
        <Check v-if="entry.kind === 'action' && entry.checked === true" :size="12" />
        <component v-else-if="iconFor(entry)" :is="iconFor(entry)" :size="12" />
      </span>
      <span class="min-w-0 flex-1 truncate">{{
        t(entry.labelKey, entry.kind === "action" ? (entry.params ?? {}) : {})
      }}</span>
      <ChevronRight v-if="entry.kind === 'submenu'" :size="11" class="shrink-0" :class="quietClass" />
      <span
        v-else-if="entry.kind === 'action' && entry.shortcut"
        class="shrink-0 font-mono text-[10px]"
        :class="quietClass"
      >
        {{ accelFor(entry) }}
      </span>
    </button>
  </template>
</template>
