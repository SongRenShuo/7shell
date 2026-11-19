<script setup lang="ts">
/**
 * The desktop's services window: the TCP ports the host is listening on, and a way to reach each.
 *
 * The reading is the host's own word — every port with the address it binds and the process behind
 * it, exactly as `ss` on that machine reported it. A process under another account arrives without
 * its name, which the row says rather than guessing; a host that answers with no listeners at all
 * is drawn as the empty state it is, not as a failure.
 *
 * The reaching is the forwards manager's own engine, met per row:
 *
 * - **Open a tunnel** asks for a local forward from a free port here to the listener on the
 *   machine — the same `forwards.open` the forwards window's add form sends, with the same gate
 *   and the same audit line behind it. A wide bind (`0.0.0.0`, `::`) is narrowed to the loopback
 *   the listener actually answers on, because the row's address is a shape the host printed, not
 *   an address to dial.
 * - **Open in browser** opens that tunnel first and points this machine's browser at the local end
 *   — the one-button path to a web service the host is serving. A port that answers something
 *   other than HTTP shows whatever it shows; the browser is the reader, not this window.
 *
 * The window reads through the desktop's own connection, which is why it needs the handle and why
 * a dropped connection is the pane's disconnected sentence rather than something drawn in here.
 */
import { Cable, Globe, Radar, RefreshCw, X } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import { backend } from "@/lib/backend/api";
import { type ShellError, asShellError } from "@/lib/backend/errors";
import { useToast } from "@/composables/useToast";
import { describeShellError } from "@/i18n/errors";
import type { SystemListener } from "@/types/sysinfo";

const props = defineProps<{
  /** The session the tunnels opened here belong to; the open rides that session's connection. */
  sessionId: string;
  /** The connection the listeners are read through — the desktop's own, as the pane holds it. */
  handle: string;
  /** Whether this window is in front. The reading is taken on open and on refresh, not polled. */
  active: boolean;
}>();

const { t } = useI18n();
const { toast } = useToast();

// -- the reading -------------------------------------------------------------

const listeners = ref<readonly SystemListener[]>([]);
const reading = ref(false);
const failure = ref<ShellError | null>(null);

async function refresh(): Promise<void> {
  if (reading.value) {
    return;
  }
  reading.value = true;
  try {
    const overview = await backend.system.overview(props.handle);
    // The Rust side omits the list from the wire when the host answered with nothing, so an older
    // shape and an empty host look the same here — which is what `?? []` is for. The row drawing
    // never walks the list through a single optional link.
    listeners.value = overview.listeners ?? [];
    failure.value = null;
  } catch (error) {
    failure.value = asShellError(error, "system_overview");
  } finally {
    reading.value = false;
  }
}

onMounted(() => {
  void refresh();
});

function translate(key: string, params?: Record<string, string>): string {
  return params ? t(key, params) : t(key);
}

const describedFailure = computed(() => (failure.value ? describeShellError(translate, failure.value) : null));

/** The address a tunnel here dials: a wide bind is narrowed to the loopback it answers on. */
function targetHostOf(listener: SystemListener): string {
  if (listener.address === "0.0.0.0" || listener.address === "::" || listener.address === "*") {
    return "127.0.0.1";
  }
  return listener.address;
}

/** What a row names the process that would not say its name. */
function processOf(listener: SystemListener): string {
  return listener.process === "" ? t("workbench.desktop.services.unnamed") : listener.process;
}

// -- the reaching ------------------------------------------------------------

const opening = ref<string | null>(null);

/**
 * Opens a local forward from a free port here to this listener, and says where the local end is.
 * The receipt is a toast rather than a row: the forwards manager owns the list of what is up, and
 * duplicating it here would make two windows disagree about one forward.
 */
async function openTunnel(listener: SystemListener): Promise<void> {
  const key = `${listener.address}:${listener.port}`;
  if (opening.value !== null) {
    return;
  }
  opening.value = key;
  try {
    const opened = await backend.forwards.open(props.sessionId, {
      mode: "local",
      bindHost: "127.0.0.1",
      bindPort: 0,
      targetHost: targetHostOf(listener),
      targetPort: listener.port,
    });
    failure.value = null;
    toast(
      t("workbench.desktop.services.tunnelOpened", {
        bind: `127.0.0.1:${opened.bindPort}`,
        target: `${targetHostOf(listener)}:${listener.port}`,
      }),
      "receipt",
    );
  } catch (error) {
    failure.value = asShellError(error, "tunnel_open");
  } finally {
    opening.value = null;
  }
}

/**
 * Opens the tunnel, then this machine's browser at the local end of it. The tunnel is the same ask
 * as the button beside it — the browser is only where the reading goes next.
 */
async function openBrowser(listener: SystemListener): Promise<void> {
  const key = `${listener.address}:${listener.port}`;
  if (opening.value !== null) {
    return;
  }
  opening.value = key;
  try {
    const opened = await backend.forwards.open(props.sessionId, {
      mode: "local",
      bindHost: "127.0.0.1",
      bindPort: 0,
      targetHost: targetHostOf(listener),
      targetPort: listener.port,
    });
    failure.value = null;
    const url = `http://127.0.0.1:${opened.bindPort}`;
    window.open(url, "_blank", "noopener,noreferrer");
    toast(t("workbench.desktop.services.browserOpened", { url }), "receipt");
  } catch (error) {
    failure.value = asShellError(error, "tunnel_open");
  } finally {
    opening.value = null;
  }
}
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col overflow-hidden" data-workbench-services-window>
    <header class="flex items-center gap-2 border-b border-border px-3 py-[var(--panel-header-y)]">
      <h2 class="min-w-0 flex-1 text-xs font-medium">{{ t("workbench.desktop.services.listTitle") }}</h2>
      <button
        type="button"
        class="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        :disabled="reading"
        @click="refresh()"
      >
        <RefreshCw :size="11" :class="reading ? 'animate-spin' : ''" />
        {{ t("workbench.desktop.services.refresh") }}
      </button>
    </header>

    <div
      v-if="describedFailure"
      class="flex items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs"
    >
      <span class="min-w-0 flex-1">
        <p>{{ describedFailure.message }}</p>
        <p class="font-mono text-[10px] text-muted-foreground">{{ describedFailure.code }}</p>
      </span>
      <button
        type="button"
        class="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        :aria-label="t('common.action.close')"
        @click="failure = null"
      >
        <X :size="11" />
      </button>
    </div>

    <!-- What the host is listening on. -->
    <div class="min-h-0 flex-1 overflow-auto" data-workbench-services-rows>
      <p
        v-if="listeners.length === 0 && !reading"
        class="px-4 py-4 text-center text-xs text-muted-foreground"
        data-workbench-services-empty
      >
        {{ t("workbench.desktop.services.empty") }}
      </p>
      <ul v-else class="py-1">
        <li
          v-for="listener in listeners"
          :key="`${listener.address}:${listener.port}`"
          class="flex items-center gap-2 rounded-md px-3 py-1.5 hover:bg-accent/50"
          data-workbench-services-row
          :data-service-port="listener.port"
        >
          <Radar :size="13" class="shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-1.5 font-mono text-[11px]">
              <span class="shrink-0">{{ listener.address }}:{{ listener.port }}</span>
              <span class="min-w-0 truncate font-sans text-[10px] text-muted-foreground">{{
                processOf(listener)
              }}</span>
            </span>
          </span>
          <button
            type="button"
            class="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            :title="t('workbench.desktop.services.openTunnel')"
            :disabled="opening !== null"
            @click="openTunnel(listener)"
          >
            <Cable :size="11" />
            {{ t("workbench.desktop.services.openTunnel") }}
          </button>
          <button
            type="button"
            class="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            :title="t('workbench.desktop.services.openBrowser')"
            :disabled="opening !== null"
            @click="openBrowser(listener)"
          >
            <Globe :size="11" />
            {{ t("workbench.desktop.services.openBrowser") }}
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>
