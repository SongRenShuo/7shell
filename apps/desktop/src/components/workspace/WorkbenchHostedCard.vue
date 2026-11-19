<script setup lang="ts">
/**
 * The stub a desktop tab collapses to while a system browser draws the workbench.
 *
 * It is the connection's anchor in the application: the pane underneath is unmounted while the
 * browser carries the face — that is the memory budget the handover buys — but the tab, its handle
 * and everything the session remembers stand exactly where they were, so closing the browser tab
 * ends the hosting and not the connection. The card offers the handover URL (opened by clicking it,
 * copied with the button beside it), "take the URL again" for the host that stopped itself while no
 * browser session was on it — the answer may come back on another port — and "take back into the
 * app", which is one removal from the store's hosted memory: the pane draws again on the same
 * connection, and the desktop's own memories (geometry, icons, wallpaper) were never touched.
 */
import { Copy, RotateCw, Undo2 } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import { useToast } from "@/composables/useToast";
import { useTerminalsStore, type WorkbenchTab } from "@/stores/terminals";

const props = defineProps<{
  /** The desktop tab this stub stands in for: its session names the connection the browser rides. */
  tab: WorkbenchTab;
}>();

const { t } = useI18n();
const terminals = useTerminalsStore();
const { toast } = useToast();

/** The URL the handover opened, from the store's memory of the session's hosted state. */
const url = computed(() => terminals.hostedUrl(props.tab.session.id) ?? "");

/** Puts the handover URL on the clipboard, and says which of the two things happened. */
async function copyUrl(): Promise<void> {
  try {
    await navigator.clipboard.writeText(url.value);
    toast(t("workbench.hosted.copied"), "receipt");
  } catch {
    toast(t("workbench.hosted.copyFailed"), "failure");
  }
}

/** Asks for the URL again: the host may have stopped itself, and a fresh start may answer elsewhere. */
function refreshUrl(): void {
  void terminals.refreshHostedUrl(props.tab.session.id);
}

/** Takes the desktop back into the application: the stub goes, the pane draws again on its handle. */
function takeBack(): void {
  terminals.unhost(props.tab.session.id);
}
</script>

<template>
  <section
    data-workbench-hosted
    class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-background p-6 text-center"
  >
    <p class="text-sm" data-workbench-hosted-title>{{ t("workbench.hosted.title", { name: tab.session.name }) }}</p>

    <!--
      The URL is the one fact the stub has to keep reachable: clicking it opens the browser tab
      again, the button beside it copies it for whoever wants to paste it somewhere else.
    -->
    <div
      data-workbench-hosted-url
      class="flex max-w-full items-center gap-2 rounded-md border border-border bg-muted px-3 py-2"
    >
      <a
        :href="url"
        target="_blank"
        rel="noreferrer"
        data-workbench-hosted-link
        class="truncate font-mono text-xs hover:underline"
        :aria-label="t('workbench.hosted.urlLabel')"
        >{{ url }}</a
      >
      <button
        type="button"
        data-workbench-hosted-copy
        class="flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px] transition-colors hover:bg-accent"
        :title="t('workbench.hosted.copy')"
        :aria-label="t('workbench.hosted.copy')"
        @click="copyUrl()"
      >
        <Copy :size="14" />
      </button>
    </div>

    <p class="max-w-md text-xs text-muted-foreground" data-workbench-hosted-explanation>
      {{ t("workbench.hosted.explanation") }}
    </p>

    <div class="flex items-center gap-2">
      <button
        type="button"
        data-workbench-hosted-refresh
        class="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-accent"
        @click="refreshUrl()"
      >
        <RotateCw :size="12" />
        {{ t("workbench.hosted.refresh") }}
      </button>
      <button
        type="button"
        data-workbench-hosted-take-back
        class="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-accent"
        @click="takeBack()"
      >
        <Undo2 :size="12" />
        {{ t("workbench.hosted.takeBack") }}
      </button>
    </div>
  </section>
</template>
