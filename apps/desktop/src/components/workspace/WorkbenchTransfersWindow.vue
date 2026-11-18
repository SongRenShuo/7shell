<script setup lang="ts">
/**
 * The desktop's transfers window: where the bytes that are moving are, in a frame of their own.
 *
 * What it hosts is the ordinary [TransferPanel] — the same floating list the shell draws over the
 * workspace, pill and all — with no tab and no connection of its own. A transfer belongs to the
 * channel it rides on, which is why there is nothing to open or close here: the window is a place
 * to see and stop what is already moving, wherever it was started from, and an empty window means
 * exactly that — nothing is moving.
 */
import TransferPanel from "@/components/shell/TransferPanel.vue";
</script>

<template>
  <!-- Relative, because the panel floats into the corner of whatever hosts it. -->
  <div class="relative flex min-h-0 flex-1 flex-col overflow-hidden" data-workbench-transfers-window>
    <TransferPanel class="h-full" />
  </div>
</template>
