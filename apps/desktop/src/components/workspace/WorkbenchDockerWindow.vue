<script setup lang="ts">
/**
 * The desktop's Docker window: the container workspace, in a frame on the desktop.
 *
 * The workspace itself is not rewritten here — what this window hosts is the ordinary
 * [ContainerPane], the same one a container tab in the strip draws, over the same store and the
 * same connection lifecycle. What the window adds is the piece a desktop window owns instead of a
 * tab: the connection is opened when the window is drawn and closed by the tab's own close when the
 * window goes away, and until the engine answers, the window says so rather than showing an empty
 * room. A tab opened for a desktop carries no pane of its own to do the asking, which is why the
 * open is made here — on mount, through the store's own entry, exactly as the pane in the strip
 * does for its tab.
 */
import { LoaderCircle, RotateCw } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted } from "vue";
import { useI18n } from "vue-i18n";

import ContainerPane from "@/components/container/ContainerPane.vue";
import { describeShellError } from "@/i18n/errors";
import { useContainerStore } from "@/stores/container";
import type { ContainerTab } from "@/stores/terminals";

const props = defineProps<{
  /** The container tab this window draws: the engine's owner, and the holder of its connection. */
  tab: ContainerTab;
  /** Whether this window is the one in front. A hidden window's stream keeps its place either way. */
  active: boolean;
}>();

const { t } = useI18n();
const containers = useContainerStore();

const session = computed(() => containers.sessionFor(props.tab.id));
const problem = computed(() => (session.value?.error ? describeShellError(translate, session.value.error) : null));

function translate(key: string, params?: Record<string, string>): string {
  return params ? t(key, params) : t(key);
}

function retry(): void {
  void containers.connect(props.tab);
}

onMounted(() => {
  void containers.connect(props.tab);
});

onBeforeUnmount(() => {
  // Not `close`: the tab's own close path has already disconnected by `tab.connectionId`, and the
  // pane forgets its share on its own unmount. This covers the window going away before any pane
  // was mounted — a connection that never came up leaves nothing behind.
  containers.forget(props.tab.id);
});
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col overflow-hidden" data-workbench-docker-window>
    <!-- The workspace, once there is an engine to draw. The pane keeps its own views mounted. -->
    <ContainerPane v-if="tab.connectionId !== null" :tab="tab" :active="active" class="h-full" />

    <!-- The connection as it is being made. -->
    <div
      v-else-if="!session || (session.loading && session.connectionId === null)"
      class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
    >
      <LoaderCircle :size="16" class="animate-spin text-muted-foreground" />
      <p class="text-xs text-muted-foreground">{{ t("container.connecting") }}</p>
    </div>

    <!-- The connection as it failed to be made, and the way back. -->
    <div v-else class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <p class="text-xs text-muted-foreground">{{ t("container.connectFailed") }}</p>
      <p v-if="problem" class="max-w-xl text-xs text-destructive select-text">{{ problem.message }}</p>
      <p v-if="problem" class="font-mono text-[10px] text-muted-foreground">{{ problem.code }}</p>
      <button
        type="button"
        class="mt-1 flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-accent"
        @click="retry()"
      >
        <RotateCw :size="12" />
        {{ t("container.retry") }}
      </button>
    </div>
  </section>
</template>
