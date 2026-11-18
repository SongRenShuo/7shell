<script lang="ts">
/**
 * The notification centre's panel: the 384px sheet the reference's Notification width, drawn at the
 * desk's lower right with the rest of the desktop's chrome tokens.
 *
 * It is presentational, and doubly so: the notices arrive already translated and already labelled
 * with a time, because this component imports no translations and formats no clocks — the owner
 * (the pane) knows the language and the moment. What can only belong here is the reading of the
 * rows: grouping by source with a count at each group head, the unread mark on the rows a session
 * has not seen, the activation (a click on a row is both "I saw this" and, when the source has a
 * window to open, "take me there"), and the one destructive verb — clear — which is asked about
 * first, the way every destructive verb on this desktop is.
 *
 * The empty state is the desktop's shared empty drawing, saying what the owner handed over as the
 * sentence for "nothing has happened".
 */

/** A row the panel can draw: the pane's translation of a stored notice. */
export interface NoticeRow {
  readonly id: string;
  /** The source's own key, which is also which group the row belongs to. */
  readonly source: NoticeSourceKey;
  readonly title: string;
  readonly body?: string;
  readonly atLabel: string;
  readonly read: boolean;
  /** Whether a click on the row is a jump as well as a read. */
  readonly actionable: boolean;
}

export type NoticeSourceKey = "transfer" | "container" | "tail" | "power";

/** The groups in the order the panel draws them. */
export const NOTICE_GROUPS: readonly NoticeSourceKey[] = ["transfer", "container", "tail", "power"];
</script>

<script setup lang="ts">
import { computed, ref } from "vue";
import { X } from "@lucide/vue";

import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import WbEmpty from "@/components/ui/WbEmpty.vue";

const props = defineProps<{
  /** Every notice, newest first, already translated into rows. */
  notices: NoticeRow[];
  /** What each group is called, already translated. */
  groupLabels: Record<NoticeSourceKey, string>;
  labels: {
    /** The panel's accessible name. */
    title: string;
    /** Said by the empty drawing when there is nothing to group. */
    empty: string;
    /** What the clear button is called. */
    clear: string;
    /** The confirmation's three sentences. */
    clearTitle: string;
    clearMessage: string;
    clearConfirm: string;
  };
}>();

const emit = defineEmits<{
  /** A row was clicked: read, and jumped to when it has somewhere to go. */
  activate: [id: string];
  /** The confirmation was answered yes: the rows are going away. */
  clear: [];
  /** Somebody asked for the panel to go away. */
  close: [];
}>();

/** The groups that have something in them, in the drawing order. */
const groups = computed(() =>
  NOTICE_GROUPS.map((source) => ({
    source,
    label: props.groupLabels[source],
    rows: props.notices.filter((row) => row.source === source),
  })).filter((group) => group.rows.length > 0),
);

/** Whether the destructive verb is being asked about. */
const askingClear = ref(false);
</script>

<template>
  <section data-workbench-notices class="notices" role="dialog" :aria-label="labels.title">
    <header class="notices-head">
      <h2 class="notices-title">{{ labels.title }}</h2>
      <div class="flex items-center gap-1">
        <button
          type="button"
          data-workbench-notices-clear
          class="notices-clear"
          :disabled="notices.length === 0"
          @click="askingClear = true"
        >
          {{ labels.clear }}
        </button>
        <button type="button" data-workbench-notices-close class="notices-close" @click="emit('close')">
          <X :size="16" aria-hidden="true" />
        </button>
      </div>
    </header>

    <div class="notices-scroll">
      <WbEmpty v-if="notices.length === 0" scenario="noData" size="sm" :title="labels.empty" class="py-8" />
      <template v-else>
        <section v-for="group in groups" :key="group.source" class="notices-group">
          <h3 class="notices-group-head">
            <span>{{ group.label }}</span>
            <span class="notices-group-count" :data-count="group.rows.length">{{ group.rows.length }}</span>
          </h3>
          <button
            v-for="row in group.rows"
            :key="row.id"
            type="button"
            class="notices-row"
            :data-notice-id="row.id"
            :data-notice-source="row.source"
            :data-read="row.read ? 'true' : undefined"
            @click="emit('activate', row.id)"
          >
            <span class="notices-dot" aria-hidden="true"></span>
            <span class="min-w-0 flex-1">
              <span class="notices-row-title">{{ row.title }}</span>
              <span v-if="row.body !== undefined" class="notices-row-body">{{ row.body }}</span>
            </span>
            <span class="notices-row-time">{{ row.atLabel }}</span>
          </button>
        </section>
      </template>
    </div>

    <ConfirmDialog
      :open="askingClear"
      :title="labels.clearTitle"
      :message="labels.clearMessage"
      :confirm-label="labels.clearConfirm"
      danger
      @confirm="
        askingClear = false;
        emit('clear');
      "
      @update:open="askingClear = false"
    />
  </section>
</template>

<style scoped>
/*
 * The panel draws from the desktop's own tokens, the way the starter and the taskbar do — it is
 * chrome over whatever the desk is wearing, not a themed surface of its own. The width is the
 * reference's Notification (384px); the height is the desk's business, capped so a full centre
 * scrolls instead of pushing past the taskbar.
 */
.notices {
  display: flex;
  width: 384px;
  max-width: calc(100vw - 24px);
  max-height: min(60vh, 560px);
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--wb-radius-content);
  border: 1px solid var(--workbench-glass-border);
  background: var(--workbench-surface-2);
  color: var(--workbench-on-picture);
  box-shadow: var(--wb-shadow-elevated);
  backdrop-filter: blur(15px);
  -webkit-backdrop-filter: blur(15px);
}

.notices-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--workbench-glass-border);
}

.notices-title {
  font-size: 14px;
  font-weight: 500;
}

.notices-clear {
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  color: var(--workbench-on-picture-muted);
  transition: background-color var(--wb-dur-base);
  cursor: pointer;
}

.notices-clear:hover:not(:disabled),
.notices-clear:focus-visible {
  background: var(--workbench-wash-hover);
  color: var(--workbench-on-picture);
}

.notices-clear:disabled {
  opacity: 0.45;
  cursor: default;
}

.notices-clear:focus-visible {
  outline: 1px solid var(--workbench-focus-outline);
  outline-offset: -1px;
}

.notices-close {
  display: flex;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  color: var(--workbench-on-picture-muted);
  transition:
    background-color var(--wb-dur-base),
    color var(--wb-dur-base);
  cursor: pointer;
}

.notices-close:hover,
.notices-close:focus-visible {
  background: var(--workbench-wash-hover);
  color: var(--workbench-on-picture);
}

.notices-close:focus-visible {
  outline: 1px solid var(--workbench-focus-outline);
  outline-offset: -1px;
}

.notices-scroll {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px 10px;
}

.notices-group + .notices-group {
  margin-top: 10px;
}

.notices-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 6px 4px;
  font-size: 11px;
  font-weight: 500;
  color: var(--workbench-on-picture-muted);
}

/* The group head's count, the reference's "{name}（{count}）" said as a chip beside the name. */
.notices-group-count {
  min-width: 18px;
  border-radius: 999px;
  padding: 0 5px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: center;
  background: var(--workbench-wash-hover);
  color: var(--workbench-on-picture);
}

.notices-row {
  display: flex;
  width: 100%;
  align-items: flex-start;
  gap: 8px;
  border-radius: 6px;
  padding: 7px 8px;
  text-align: left;
  transition: background-color var(--wb-dur-base);
  cursor: pointer;
}

.notices-row:hover,
.notices-row:focus-visible {
  background: var(--workbench-wash-hover);
}

.notices-row:focus-visible {
  outline: 1px solid var(--workbench-focus-outline);
  outline-offset: -1px;
}

/* The unread mark: a small accent dot that a read row does not carry. */
.notices-dot {
  width: 6px;
  height: 6px;
  flex: none;
  margin-top: 5px;
  border-radius: 999px;
  background: var(--workbench-accent);
}

.notices-row[data-read="true"] .notices-dot {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--workbench-glass-border);
}

.notices-row-title {
  display: block;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notices-row-body {
  display: block;
  overflow: hidden;
  margin-top: 1px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--workbench-on-picture-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notices-row-time {
  flex: none;
  margin-top: 2px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--workbench-on-picture-muted);
}
</style>
