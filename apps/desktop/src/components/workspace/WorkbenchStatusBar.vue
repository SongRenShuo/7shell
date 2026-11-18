<script setup lang="ts">
/**
 * The strip along the top of the desktop: the machine on the left, who is on it on the right.
 *
 * It carries no state of its own. The host, the account and the time are handed in by whoever owns
 * the session — the time is read once a minute in one place, not by each of the strip's three
 * windows onto it — and the one thing a person can do here, letting the connection go, is asked of
 * that owner too.
 *
 * The strip is drawn in the desktop's own colours rather than the theme's: `--workbench-surface-1`
 * behind it and `--workbench-on-picture` for its text, the tokens the desktop chrome names in
 * `globals.css`. It stands on a picture, and a light theme's foreground on a dark wallpaper is the
 * unreadable state the first release shipped. 23 pixels tall with 13px text is the strip the
 * desktop this copies draws.
 */
import { Power } from "@lucide/vue";

defineProps<{
  /** The machine this desktop is about, in the interface's monospace face. */
  host: string;
  /** The account the session signed in as. */
  user: string;
  /** The time, already formatted by the owner. This component adds no clock of its own. */
  clock: string;
  /** Whether there is a connection to let go of: an ended session has nothing to disconnect. */
  connected: boolean;
  labels: {
    /** What the disconnect button is called, for its tooltip and its accessible name. */
    disconnect: string;
  };
}>();

const emit = defineEmits<{
  /** Somebody asked to let the connection go. */
  disconnect: [];
}>();
</script>

<template>
  <header
    data-workbench-status-bar
    class="flex h-[23px] w-full shrink-0 select-none items-center justify-between gap-3 bg-[var(--workbench-surface-1)] px-2 text-[13px] leading-none text-[var(--workbench-on-picture)]"
  >
    <span class="truncate font-mono" data-workbench-status-host>{{ host }}</span>

    <div class="flex min-w-0 items-center gap-3">
      <span class="truncate" data-workbench-status-user>{{ user }}</span>
      <span class="tabular-nums" data-workbench-status-clock>{{ clock }}</span>
      <!--
        The same control the reference draws as a bare icon at the end of the strip. It is disabled
        when there is nothing to disconnect, because a live button that does nothing reads as broken.
      -->
      <button
        type="button"
        data-workbench-status-disconnect
        :disabled="!connected"
        :title="labels.disconnect"
        :aria-label="labels.disconnect"
        class="-mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px] transition-colors hover:bg-[var(--workbench-wash-hover)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        @click="emit('disconnect')"
      >
        <Power :size="14" />
      </button>
    </div>
  </header>
</template>
