<script setup lang="ts">
/**
 * The machine's trash, as a panel inside the desktop.
 *
 * A freedesktop trash is two directories (`files/` and `info/`, each entry paired with a sidecar
 * naming where it came from), and this panel is the window onto it: list what is there, put one
 * back where it was, delete one for good, or empty the lot.
 *
 * Three decisions are worth knowing before reading the rest:
 *
 * 1. **An entry with no original path can be removed but not restored.** A sidecar that could not
 *    be paired, or whose Path line failed the judgement, leaves the file listable — deleting it is
 *    somebody's decision — but restoring it would be a guess at where it used to live, and a guess
 *    that writes to the wrong place is worse than a disabled button.
 * 2. **Emptying is the one destructive verb, and it is the shell's gate that decides.** The panel
 *    asks first (a question naming the count) and passes the answer along; the policy matrix and
 *    the audit line live in `Core::trash_empty`, not here.
 * 3. **The list is read on open and after every change.** There is no poll: the trash changes when
 *    somebody changes it, and a background read of a remote directory every few seconds would be a
 *    cost paid by the machine for a panel that is mostly not on screen.
 */
import { LoaderCircle, RefreshCw, RotateCcw, Trash2, X } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import { describeShellError } from "@/i18n/errors";
import { backend } from "@/lib/backend/api";
import { asShellError } from "@/lib/backend/errors";
import { formatSize } from "@/lib/files/format";
import { TABLE, rowClass } from "@/lib/table";
import { cn } from "@/lib/utils";
import { useToast } from "@/composables/useToast";
import type { TrashEntry } from "@/types/session";

const props = defineProps<{
  /** The session the trash belongs to, which is what a policy decision about emptying names. */
  sessionId: string;
  /** The SSH connection the reads ride on, the way every other file surface reaches the host. */
  handle: string;
  /** Whether the panel is the one on screen; a hidden panel does not keep a list fresh. */
  active: boolean;
  /** Whether the panel is drawn inside a desktop window, which already carries its title and close. */
  embedded?: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const { toast } = useToast();

const entries = ref<TrashEntry[]>([]);
const reading = ref(false);
const failure = ref<ReturnType<typeof asShellError> | null>(null);
const busy = ref<string | null>(null);
const askingEmpty = ref(false);

const readable = computed(() => describe(failure.value));
const count = computed(() => entries.value.length);
const empty = computed(() => !reading.value && count.value === 0);

function describe(error: ReturnType<typeof asShellError> | null): string | null {
  return error ? describeShellError(t as unknown as Parameters<typeof describeShellError>[0], error).message : null;
}

async function read(): Promise<void> {
  if (!props.active) {
    return;
  }
  reading.value = true;
  try {
    entries.value = await backend.files.trashList(props.handle);
    failure.value = null;
  } catch (error) {
    failure.value = asShellError(error, "trash_list");
  } finally {
    reading.value = false;
  }
}

/** Where an entry came from, or a sentence saying nobody knows. */
function origin(entry: TrashEntry): string {
  return entry.originalPath ?? t("workbench.trash.unknownOrigin");
}

/** A size a person can read, or nothing when the host did not say. */
function size(entry: TrashEntry): string {
  return entry.size === undefined ? "-" : formatSize(entry.size);
}

async function restore(entry: TrashEntry): Promise<void> {
  busy.value = entry.id;
  try {
    const landed = await backend.files.trashRestore(props.handle, entry.id);
    toast(t("workbench.trash.restored", { name: entry.name, path: landed }), "receipt");
    await read();
  } catch (error) {
    toast(describe(asShellError(error, "trash_restore")) ?? t("workbench.trash.failed"), "failure");
  } finally {
    busy.value = null;
  }
}

async function remove(entry: TrashEntry): Promise<void> {
  busy.value = entry.id;
  try {
    await backend.files.trashRemove(props.handle, props.sessionId, entry.id, true);
    toast(t("workbench.trash.removed", { name: entry.name }), "receipt");
    await read();
  } catch (error) {
    toast(describe(asShellError(error, "trash_remove")) ?? t("workbench.trash.failed"), "failure");
  } finally {
    busy.value = null;
  }
}

async function emptyTrash(): Promise<void> {
  askingEmpty.value = false;
  try {
    const outcome = await backend.files.trashEmpty(props.handle, props.sessionId, true);
    toast(t("workbench.trash.emptied", { count: outcome.removed }), "receipt");
    await read();
  } catch (error) {
    toast(describe(asShellError(error, "trash_empty")) ?? t("workbench.trash.failed"), "failure");
  }
}

// The panel reads when it becomes the one on screen and when it is first drawn on screen — never
// while hidden, and never on a clock.
watch(
  () => [props.active, props.handle] as const,
  () => void read(),
  { immediate: true },
);
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col" data-workbench-trash>
    <header class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
      <template v-if="!embedded">
        <Trash2 :size="13" class="text-muted-foreground" />
        <span class="text-xs font-medium">{{ t("workbench.trash.title") }}</span>
      </template>
      <span v-if="count > 0" class="text-[11px] text-muted-foreground">{{ count }}</span>
      <span class="flex-1" />
      <button
        type="button"
        class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        :title="t('workbench.trash.refresh')"
        :disabled="reading"
        @click="read()"
      >
        <RefreshCw :size="12" :class="reading ? 'animate-spin' : ''" />
      </button>
      <button
        type="button"
        class="rounded-md px-2 py-1 text-[11px] text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="count === 0"
        @click="askingEmpty = true"
      >
        {{ t("workbench.trash.empty") }}
      </button>
      <button
        v-if="!embedded"
        type="button"
        class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        :title="t('common.action.close')"
        @click="emit('close')"
      >
        <X :size="12" />
      </button>
    </header>

    <div v-if="readable" class="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5">
      <p class="text-[11px]">{{ readable }}</p>
    </div>

    <div class="min-h-0 flex-1 overflow-auto">
      <table v-if="count > 0" :class="TABLE.page.table" :aria-label="t('workbench.trash.title')">
        <thead :class="TABLE.page.head">
          <tr :class="TABLE.page.headRow">
            <th :class="cn(TABLE.page.headCell, 'w-[28%] text-left')">{{ t("workbench.trash.name") }}</th>
            <th :class="cn(TABLE.page.headCell, 'text-left')">{{ t("workbench.trash.origin") }}</th>
            <th :class="cn(TABLE.page.headCell, 'w-24 text-right')">{{ t("workbench.trash.size") }}</th>
            <th :class="cn(TABLE.page.headCell, 'w-40 text-right')">{{ t("workbench.trash.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in entries" :key="entry.id" :class="rowClass('page')">
            <td :class="cn(TABLE.page.cell, 'truncate')" :title="entry.name">
              {{ entry.name }}<span v-if="entry.isDir" class="text-muted-foreground">/</span>
            </td>
            <td
              :class="cn(TABLE.page.cell, 'truncate font-mono text-[11px] text-muted-foreground')"
              :title="origin(entry)"
            >
              {{ origin(entry) }}
            </td>
            <td :class="cn(TABLE.page.cell, 'text-right font-mono text-[11px] text-muted-foreground')">
              {{ size(entry) }}
            </td>
            <td :class="cn(TABLE.page.cell, 'text-right')">
              <span class="inline-flex items-center gap-1">
                <button
                  type="button"
                  class="rounded-md px-2 py-0.5 text-[11px] transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="entry.originalPath === undefined || busy === entry.id"
                  :title="
                    entry.originalPath === undefined ? t('workbench.trash.cannotRestore') : t('workbench.trash.restore')
                  "
                  @click="restore(entry)"
                >
                  <RotateCcw :size="11" />
                </button>
                <button
                  type="button"
                  class="rounded-md px-2 py-0.5 text-[11px] text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="busy === entry.id"
                  :title="t('workbench.trash.deleteForever')"
                  @click="remove(entry)"
                >
                  <Trash2 :size="11" />
                </button>
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-else class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <LoaderCircle v-if="reading" :size="16" class="animate-spin text-muted-foreground" />
        <Trash2 v-else :size="18" class="text-muted-foreground" />
        <p class="text-xs text-muted-foreground">
          {{ reading ? t("workbench.trash.reading") : t("workbench.trash.emptyState") }}
        </p>
        <p v-if="empty" class="text-[11px] text-muted-foreground">{{ t("workbench.trash.emptyHint") }}</p>
      </div>
    </div>

    <ConfirmDialog
      :open="askingEmpty"
      :title="t('workbench.trash.emptyTitle')"
      :message="t('workbench.trash.emptyMessage', { count })"
      :confirm-label="t('workbench.trash.empty')"
      danger
      @confirm="emptyTrash()"
      @update:open="askingEmpty = false"
    />
  </section>
</template>
