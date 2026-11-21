<script setup lang="ts">
/**
 * The desktop's transfers window: where the bytes that are moving are, in a frame of their own.
 *
 * What it hosts is the ordinary [TransferPanel] — the same floating list the shell draws over the
 * workspace, pill and all — with no tab and no connection of its own. A transfer belongs to the
 * channel it rides on, which is why there is nothing to open or close here: the window is a place
 * to see and stop what is already moving, wherever it was started from.
 *
 * The panel's own idle branch draws nothing at all — right for a floater that vanishes when put
 * away, wrong for a window, where a blank frame reads as broken. So the window says what an idle
 * panel means, and where a transfer would have to come from.
 */
import { ArrowUpDown } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import TransferPanel from "@/components/shell/TransferPanel.vue";
import { useFilesStore } from "@/stores/files";

const { t } = useI18n();
const files = useFilesStore();

/** The exact condition under which the panel's root `v-if` renders nothing. */
const idle = computed(() => files.transfers.length === 0 && files.transferFailure === null && !files.panelExpanded);
</script>

<template>
  <!-- Relative, because the panel floats into the corner of whatever hosts it. -->
  <div class="relative flex min-h-0 flex-1 flex-col overflow-hidden" data-workbench-transfers-window>
    <TransferPanel v-if="!idle" class="h-full" />
    <div v-else class="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center" data-transfers-empty>
      <ArrowUpDown :size="22" class="text-muted-foreground/60" />
      <p class="text-xs text-muted-foreground">{{ t("workbench.desktop.transfers.empty") }}</p>
      <p class="max-w-[26rem] text-[11px] text-muted-foreground/70">
        {{ t("workbench.desktop.transfers.emptyHint") }}
      </p>
    </div>
  </div>
</template>
