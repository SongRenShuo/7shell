<script setup lang="ts">
/**
 * The file browser's other quick jumps: the directories this session has actually walked into.
 *
 * The bookmarks menu (its neighbour on the path bar) holds the places somebody decided matter;
 * this one holds the places the session has already been, most recent first — the `/var/log` you
 * reached through four directories five minutes ago is one click away the second time.
 *
 * The list is per session and kept on this device (`lib/files/panelMemory`): the same panel on two
 * connections must not hand one server's history to another. It is read when the popover opens,
 * because navigation closes the popover — anything open while the list changed is already gone —
 * and clearing is one press, the way bookmark removal is.
 */
import { History, Trash2 } from "@lucide/vue";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import { clearRecent, loadRecent } from "@/lib/files/panelMemory";

const props = defineProps<{ sessionId: string }>();
const emit = defineEmits<{ jump: [path: string] }>();

const { t } = useI18n();

const open = ref(false);
const recent = ref<string[]>([]);

/** The name a row shows: the last segment, the way a directory introduces itself. */
function labelFor(path: string): string {
  if (path === "/") {
    return "/";
  }
  const segment = path
    .split("/")
    .filter((part) => part !== "")
    .at(-1);
  return segment ?? path;
}

/** Re-reads the list when the popover opens or the session changes underneath it. */
function refresh(): void {
  recent.value = loadRecent(props.sessionId);
}

function jump(path: string): void {
  open.value = false;
  emit("jump", path);
}

function clear(): void {
  clearRecent(props.sessionId);
  recent.value = [];
}

const shown = computed(() => recent.value);
</script>

<template>
  <PopoverRoot :open="open" @update:open="open = $event">
    <PopoverTrigger as-child>
      <button
        type="button"
        data-recent-menu
        class="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        :title="t('files.recent.title')"
        :aria-label="t('files.recent.title')"
        @click="refresh()"
      >
        <History :size="12" />
      </button>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        align="start"
        side="bottom"
        :side-offset="4"
        class="z-50 w-72 rounded-md border border-border bg-background p-1 shadow-md"
      >
        <span class="block px-2 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {{ t("files.recent.title") }}
        </span>
        <div v-if="shown.length === 0" class="px-2 py-2 text-[11px] text-muted-foreground" data-recent-empty>
          {{ t("files.recent.empty") }}
        </div>
        <template v-else>
          <div class="max-h-56 overflow-auto" data-recent-list>
            <button
              v-for="path in shown"
              :key="path"
              type="button"
              data-recent-entry
              class="flex h-6 w-full items-center gap-1.5 rounded-sm px-2 text-left text-[11px] transition-colors hover:bg-accent hover:text-foreground"
              :title="t('files.recent.jump', { path })"
              @click="jump(path)"
            >
              <span class="min-w-0 flex-1 truncate">{{ labelFor(path) }}</span>
            </button>
          </div>
          <div class="border-t border-border pt-1">
            <button
              type="button"
              data-recent-clear
              class="flex h-6 w-full items-center gap-1.5 rounded-sm px-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              @click="clear()"
            >
              <Trash2 :size="11" />
              <span>{{ t("files.recent.clear") }}</span>
            </button>
          </div>
        </template>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
