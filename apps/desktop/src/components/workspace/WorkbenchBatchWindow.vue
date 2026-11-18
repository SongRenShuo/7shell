<script setup lang="ts">
/**
 * The desktop's batch window: one command, many hosts, in a frame of its own.
 *
 * What it hosts is the ordinary [BatchPanel] — the same picker, command box, risk verdict and
 * per-host rows the batch tab draws — with no props and no events, because the panel brings its
 * own store, its own host library and its own risk gate, and a window that re-decided any of that
 * would be a second place for the same decision to diverge. The desktop adds the frame and nothing
 * else; that is the whole point of the window.
 */
import BatchPanel from "@/components/batch/BatchPanel.vue";
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden" data-workbench-batch-window>
    <BatchPanel class="h-full" />
  </div>
</template>
