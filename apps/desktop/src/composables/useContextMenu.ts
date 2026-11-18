/**
 * The context menu: one menu for the whole window, opened by whatever was right-clicked.
 *
 * One instance rather than one per region, for the same reason there is one toast: only one of these
 * is on screen at a time, and the region that opens it is the only thing that knows what can be done
 * to the thing under the pointer.
 *
 * `openMenu` cancels the browser's own menu itself rather than leaving that to the shell's global
 * handler. That makes a region's wiring complete on its own — one line in a component, and a component
 * mounted in a test without the shell behaves the way it does in the window. The shell's handler is
 * what covers everywhere that has no menu of its own.
 */
import { type Ref, type ShallowRef, ref, shallowRef } from "vue";

import type { MenuEntry } from "@/lib/menu/types";

/** What the menu says it is, for a reader who cannot see it. */
export interface MenuTitle {
  readonly key: string;
  readonly params?: Readonly<Record<string, string>>;
}

/**
 * Which visual language the menu is drawn in.
 *
 * `default` is the application's own: card, border, muted labels. `desktop` is the one the reference
 * desktop uses over its wallpaper — a teal sheet with white rows — because a menu opened on a
 * picture is chrome on that picture, and the interface's palette belongs to the surfaces inside its
 * windows rather than to the desktop around them. A region says which one it wants when it opens a
 * menu; nothing else changes.
 */
export type MenuTone = "default" | "desktop";

const visible: Ref<boolean> = ref(false);
const at = ref({ x: 0, y: 0 });
const title: Ref<MenuTitle> = ref({ key: "" });
const entries: ShallowRef<readonly MenuEntry[]> = shallowRef<readonly MenuEntry[]>([]);
const tone = ref<MenuTone>("default");

export function useContextMenu() {
  function openMenu(
    event: MouseEvent,
    menuTitle: MenuTitle,
    menuEntries: readonly MenuEntry[],
    options?: { readonly tone?: MenuTone },
  ): void {
    // Cancelled and stopped here: what is under the pointer has answered, and the regions above it
    // must not answer too — a row's menu would otherwise be replaced by its list's on the way up.
    event.preventDefault();
    event.stopPropagation();
    at.value = { x: event.clientX, y: event.clientY };
    title.value = menuTitle;
    entries.value = menuEntries;
    tone.value = options?.tone ?? "default";
    visible.value = true;
  }

  function closeMenu(): void {
    visible.value = false;
  }

  return { visible, at, title, entries, tone, openMenu, closeMenu };
}
