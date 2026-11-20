<script setup lang="ts">
/**
 * What stopped, gathered in one place.
 *
 * A failure is drawn on its row the moment it happens, but the rows of a batch keep arriving: after
 * one, the failures are spread through a list that also holds everything that worked, and the
 * question "what do I have to redo?" means reading the list twice. This dialog is the answer to
 * that question — for each failed transfer, the file it was moving, where it was headed, and what
 * the transfer layer said went wrong. The reason is the same sentence the row draws, the words a
 * bug report can quote, so the summary never translates the failure into something else.
 *
 * Ten is what it holds. Beyond that, one line says how many more there are, rather than a scroll
 * that quietly hides the size of what stopped: a summary that looks complete when it is not is the
 * same lie as a count that stopped counting. Every row the ten stand for is still in the panel
 * behind, one failure a row — this is the way back into it.
 *
 * Each line offers the one thing its transfer needs next, which is to be tried again — the same
 * call the row's own button makes, answered per line rather than per list, because "retry them
 * all" would repeat whatever stopped twenty transfers twenty times over.
 *
 * It belongs to the shell beside the panel rather than inside a row, because a failure outlives the
 * browser that started the transfer, and so does the question of what became of it.
 */
import { RotateCcw } from "@lucide/vue";
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

/** One line of the summary: the transfer that stopped, and what it said about it. */
export interface TransferFailureEntry {
  readonly id: string;
  /** The file's own name, as the row shows it. */
  readonly name: string;
  /** The far side of the transfer: where the bytes were headed, or coming from. */
  readonly remotePath: string;
  /** What the transfer said went wrong, in the words the row draws. */
  readonly detail: string;
}

const props = defineProps<{
  open: boolean;
  /** Every failed transfer, in the order the list draws them. */
  failures: readonly TransferFailureEntry[];
}>();

const emit = defineEmits<{ retry: [id: string]; "update:open": [value: boolean] }>();

const { t } = useI18n();

/**
 * How many failures the dialog holds before it starts counting instead of listing.
 *
 * A summary nobody scrolls is a summary somebody reads to the end; the ones past ten are named by
 * a count, and the panel behind them holds every row of them.
 */
const LIMIT = 10;

/** The lines drawn: the first ten of what came in. */
const shown = computed(() => props.failures.slice(0, LIMIT));

/** How many the ten stood for. */
const beyond = computed(() => Math.max(0, props.failures.length - LIMIT));
</script>

<template>
  <DialogRoot :open="props.open" @update:open="(value: boolean) => emit('update:open', value)">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-overlay" />
      <DialogContent
        data-transfer-failure-summary
        class="fixed top-1/2 left-1/2 z-50 flex max-h-[min(32rem,calc(100vh-2rem))] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-card shadow-[var(--wb-shadow-elevated)] select-none focus:outline-none"
      >
        <div class="shrink-0 px-4 pt-4">
          <DialogTitle class="text-sm font-medium">{{ t("files.transfer.failedSummaryTitle") }}</DialogTitle>
          <DialogDescription class="mt-1 text-xs leading-relaxed text-muted-foreground">
            {{ t("files.transfer.failedSummaryDescription", { count: props.failures.length }) }}
          </DialogDescription>
        </div>

        <ul v-if="shown.length > 0" class="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto px-4">
          <li
            v-for="failure in shown"
            :key="failure.id"
            data-transfer-failure-row
            class="rounded-md border border-border bg-background px-2.5 py-2"
          >
            <div class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate text-xs" :title="failure.remotePath">
                {{ failure.name }}
              </span>
              <!--
                The one thing this line offers, which is what the transfer needs next. An icon with
                its word kept for the tooltip and the reader, for the reason the row's button is.
              -->
              <button
                type="button"
                data-transfer-failure-retry
                class="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                :title="t('files.transfer.retry')"
                :aria-label="t('files.transfer.retry')"
                @click="emit('retry', failure.id)"
              >
                <RotateCcw :size="12" />
              </button>
            </div>

            <!-- Where the bytes were headed, one line under the name, in the face a path wears. -->
            <p class="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" :title="failure.remotePath">
              {{ failure.remotePath }}
            </p>

            <!-- What it said went wrong: the one thing on this dialog a person reads rather than recognises. -->
            <p class="mt-1 font-mono text-[10px] break-all text-muted-foreground select-text">
              {{ failure.detail }}
            </p>
          </li>
        </ul>

        <!-- The ten are a beginning, not the whole: what they stood for is said, not hidden. -->
        <p v-if="beyond > 0" data-transfer-failure-more class="shrink-0 px-4 pt-2 text-[11px] text-muted-foreground">
          {{ t("files.transfer.failedSummaryMore", { count: beyond }) }}
        </p>

        <footer class="mt-3 flex shrink-0 justify-end border-t border-border bg-muted/40 px-4 py-3">
          <button
            type="button"
            class="rounded-sm border border-border bg-background px-3 py-1.5 text-xs transition-colors hover:bg-accent"
            @click="emit('update:open', false)"
          >
            {{ t("files.transfer.dismiss") }}
          </button>
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
