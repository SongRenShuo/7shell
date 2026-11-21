<script setup lang="ts">
/**
 * The desktop's forwards window: what the session is forwarding, and a place to add another.
 *
 * Two halves, and they answer two different questions:
 *
 * - **What is up** is a reading: the live list of forwards the connection carries, each with where
 *   it listens and where it leads — `SOCKS5` standing where a dynamic forward has no destination
 *   of its own, a reversed arrow where a remote forward turns the shape around — and how many
 *   connections it has carried. The reading keeps itself current: the terminals store learns when
 *   a terminal brings a forward up or takes one down, and this window re-reads the authoritative
 *   list whenever that state moves, so a forward opened or stopped somewhere else does not stay
 *   stale here. Stopping one is the single write, and it is asked about once, plainly.
 * - **Adding one** is the reference scene, said in sentences rather than fields alone: a local forward
 *   maps a service inside the machine onto a port here, a dynamic one turns the machine into a
 *   SOCKS5 door, and a remote one opens a port on the *server* handed to something on this
 *   machine. The open answer is the runtime entry — which carries the id, and the port that was
 *   actually bound when `0` asked for a free one — and it joins the list as what is up.
 *
 * One honesty note about opening: the open runs through the shell's gate first, and where the
 * policy matrix raises a question — a remote forward always, any bind other machines could reach
 * where a layer says so — the window puts that question and the answer travels with the resend.
 * A matrix set to deny still refuses, and loosening it is the only way past a denial.
 *
 * The window is hosted by a session that has a connection forwards can ride on — SSH, or the
 * desktop's own session. Anything else is refused in a sentence, not drawn as an empty room.
 */
import { ArrowRight, Network, Plus, RotateCw, X } from "@lucide/vue";
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import Select, { type SelectOption } from "@/components/ui/Select.vue";
import { backend } from "@/lib/backend/api";
import { type ShellError, asShellError } from "@/lib/backend/errors";
import { describeShellError } from "@/i18n/errors";
import { useSessionsStore } from "@/stores/sessions";
import { useTerminalsStore } from "@/stores/terminals";
import type { ForwardMode, ForwardRequest, OpenTunnel } from "@/types/session";

const props = defineProps<{
  /** The session this window belongs to; the forwards it opens ride that session's connection. */
  sessionId: string;
}>();

const { t } = useI18n();
const library = useSessionsStore();
const terminals = useTerminalsStore();

const session = computed(() => library.sessions.find((entry) => entry.id === props.sessionId));
const hosted = computed(() => session.value?.protocol === "ssh" || session.value?.protocol === "linuxDesk");

// -- what is up ---------------------------------------------------------------

const tunnels = ref<OpenTunnel[]>([]);
const refreshing = ref(false);
const failure = ref<ShellError | null>(null);

async function refresh(): Promise<void> {
  if (refreshing.value) {
    return;
  }
  refreshing.value = true;
  try {
    tunnels.value = await backend.terminal.tunnels();
    failure.value = null;
  } catch (error) {
    failure.value = asShellError(error, "tunnel_list");
  } finally {
    refreshing.value = false;
  }
}

onMounted(() => {
  if (hosted.value) {
    void refresh();
  }
});

/**
 * The forwards elsewhere changed, so the reading changes with them.
 *
 * The terminals store's tunnel list is what moves whenever a terminal session brings forwards up,
 * takes one down, or re-reads its own — this window's own writes answer through its local list
 * below, so the watch is here for everybody *else*: a forward opened from a terminal appears, and
 * one stopped from another surface leaves, without anybody pressing refresh. The store's list is
 * the signal, not the source: the re-read is what keeps what is drawn the authoritative answer.
 */
watch(
  () => terminals.tunnels,
  () => {
    if (hosted.value) {
      void refresh();
    }
  },
);

/** The row whose stop has been asked about, or nothing while no question is on screen. */
const stopping = ref<OpenTunnel | null>(null);

const stopQuestion = ref(false);

function askStop(tunnel: OpenTunnel): void {
  stopping.value = tunnel;
  stopQuestion.value = true;
}

function dropQuestion(): void {
  stopQuestion.value = false;
  stopping.value = null;
}

async function confirmStop(): Promise<void> {
  const tunnel = stopping.value;
  if (!tunnel) {
    dropQuestion();
    return;
  }
  stopQuestion.value = false;
  try {
    await backend.forwards.stop(tunnel.id);
    failure.value = null;
  } catch (error) {
    failure.value = asShellError(error, "tunnel_stop");
  } finally {
    stopping.value = null;
    await refresh();
  }
}

function translate(key: string, params?: Record<string, string>): string {
  return params ? t(key, params) : t(key);
}

const describedFailure = computed(() => (failure.value ? describeShellError(translate, failure.value) : null));

// -- adding one -----------------------------------------------------------------

const adding = ref(false);
const addFailure = ref<ShellError | null>(null);

const mode = ref<ForwardMode>("local");
const MODES: SelectOption[] = [
  { value: "local", label: t("workbench.desktop.forwards.modeLocal") },
  { value: "dynamic", label: t("workbench.desktop.forwards.modeDynamic") },
  { value: "remote", label: t("workbench.desktop.forwards.modeRemote") },
];

const bindHost = ref("127.0.0.1");
/** Empty means automatic — port `0`, which asks the system for a free one. */
const bindPort = ref("0");
const targetHost = ref("127.0.0.1");
const targetPort = ref("");

const PORT_MAX = 65535;

function portOf(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const number = Number(trimmed);
  if (!Number.isInteger(number) || number < 0 || number > PORT_MAX) {
    return null;
  }
  return number;
}

/** Whether the add form names something the far side could actually bring up. */
const addOk = computed(() => {
  if (bindHost.value.trim() === "") {
    return false;
  }
  const bind = portOf(bindPort.value);
  if (bind === null) {
    return false;
  }
  if (mode.value === "dynamic") {
    return true;
  }
  // A local forward needs the service inside the machine; a remote one needs the service on this
  // one. Both name it with the same two fields, each mode reading them in its own direction.
  const target = portOf(targetPort.value);
  return targetHost.value.trim() !== "" && target !== null && target !== 0;
});

async function add(): Promise<void> {
  if (!addOk.value || adding.value) {
    return;
  }
  const dynamic = mode.value === "dynamic";
  const request: ForwardRequest = {
    mode: mode.value,
    bindHost: bindHost.value.trim(),
    bindPort: portOf(bindPort.value) ?? 0,
    // Empty for a dynamic forward, which has no destination of its own — the callers of it
    // choose, connection by connection. For a remote forward these two are read the other way:
    // the service is on this machine, and the server's port is the window onto it.
    targetHost: dynamic ? "" : targetHost.value.trim(),
    targetPort: dynamic ? 0 : (portOf(targetPort.value) ?? 0),
  };
  await send(request, false);
}

/**
 * One open attempt. The first runs unacknowledged — under the default matrix a loopback local or
 * dynamic forward simply opens — and where the gate comes back wanting a person, the window asks
 * and this runs again with the answer. A denial is never answered; it comes back as the failure
 * sentence, because loosening the matrix is the only way past it.
 */
async function send(request: ForwardRequest, acknowledged: boolean): Promise<void> {
  adding.value = true;
  addFailure.value = null;
  try {
    const opened = await backend.forwards.open(props.sessionId, request, acknowledged);
    // The answer joins the list as what is up — including the port that was actually bound,
    // which is the whole point of asking for `0`.
    tunnels.value = [...tunnels.value, opened];
    askingOpen.value = false;
  } catch (error) {
    const shell = asShellError(error, "tunnel_open");
    if (shell.code === "POLICY-APPROVAL-REQUIRED" && !acknowledged) {
      // The gate wants a person, not a retry loop: hold the request and ask, naming the rule
      // that fired (a remote forward, a bind the other machines could reach).
      pendingOpen.value = request;
      askingOpen.value = true;
    } else {
      addFailure.value = shell;
    }
  } finally {
    adding.value = false;
  }
}

/** The open the gate stopped for, held until somebody answers the question about it. */
const pendingOpen = ref<ForwardRequest | null>(null);
const askingOpen = ref(false);

async function confirmOpen(): Promise<void> {
  const request = pendingOpen.value;
  pendingOpen.value = null;
  askingOpen.value = false;
  if (request) {
    await send(request, true);
  }
}

function dropOpen(): void {
  pendingOpen.value = null;
  askingOpen.value = false;
}
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col overflow-hidden" data-workbench-forwards-window>
    <!-- The refusal, for a window hosted by a session that carries no forwards. -->
    <div v-if="!hosted" class="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
      <p class="max-w-sm text-xs text-muted-foreground">{{ t("workbench.desktop.forwards.notHosted") }}</p>
    </div>

    <template v-else>
      <header class="flex items-center gap-2 border-b border-border px-3 py-[var(--panel-header-y)]">
        <h2 class="min-w-0 flex-1 text-xs font-medium">{{ t("workbench.desktop.forwards.listTitle") }}</h2>
        <button
          type="button"
          class="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          :disabled="refreshing"
          @click="refresh()"
        >
          <RotateCw :size="11" :class="refreshing ? 'animate-spin' : ''" />
          {{ t("workbench.desktop.forwards.refresh") }}
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

      <!-- What is up. -->
      <div class="min-h-0 flex-1 overflow-auto" data-workbench-forwards-rows>
        <p v-if="tunnels.length === 0 && !refreshing" class="px-4 py-4 text-center text-xs text-muted-foreground">
          {{ t("workbench.desktop.forwards.empty") }}
        </p>
        <ul v-else class="py-1">
          <li
            v-for="tunnel in tunnels"
            :key="tunnel.id"
            class="flex items-center gap-2 rounded-md px-3 py-1.5 hover:bg-accent/50"
            data-workbench-forwards-row
            :data-forward-mode="tunnel.mode"
          >
            <Network :size="13" class="shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1 font-mono text-[11px]">
                <!--
                  A remote forward is the shape read backwards: its bind is a port on the server and
                  its destination is this machine, so the arrow points home and the row names its
                  kind, where a local one's shape says "local" already.
                -->
                <span
                  v-if="tunnel.mode === 'remote'"
                  class="shrink-0 font-sans text-[10px] uppercase tracking-wide text-muted-foreground"
                  >{{ t("workbench.desktop.forwards.modeRemoteTag") }}</span
                >
                <span class="min-w-0 truncate">{{ tunnel.bindHost }}:{{ tunnel.bindPort }}</span>
                <ArrowRight
                  :size="11"
                  class="shrink-0 text-muted-foreground"
                  :class="tunnel.mode === 'remote' ? 'rotate-180' : ''"
                  role="img"
                  :aria-label="
                    t(
                      tunnel.mode === 'remote'
                        ? 'workbench.desktop.forwards.remoteDirection'
                        : 'terminal.tunnels.direction',
                    )
                  "
                />
                <span v-if="tunnel.mode === 'dynamic'" class="min-w-0 truncate">SOCKS5</span>
                <span v-else class="min-w-0 truncate">{{ tunnel.targetHost }}:{{ tunnel.targetPort }}</span>
              </span>
              <span class="block text-[10px] text-muted-foreground">
                {{ t("terminal.tunnels.connections", { count: tunnel.connections }, tunnel.connections) }}
              </span>
            </span>
            <button
              type="button"
              class="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
              :title="t('workbench.desktop.forwards.stop')"
              :aria-label="t('workbench.desktop.forwards.stop')"
              @click="askStop(tunnel)"
            >
              <X :size="12" />
            </button>
          </li>
        </ul>
      </div>

      <!-- Adding one, in the scene the feature actually serves. -->
      <form class="space-y-2.5 border-t border-border px-3 py-3" data-workbench-forwards-add @submit.prevent="add()">
        <div class="flex items-center gap-2 text-xs">
          <span class="shrink-0 text-muted-foreground">{{ t("workbench.desktop.forwards.modeLabel") }}</span>
          <Select
            :model-value="mode"
            :options="MODES"
            size="compact"
            :aria-label="t('workbench.desktop.forwards.modeLabel')"
            @update:model-value="mode = $event as ForwardMode"
          />
        </div>

        <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          <label class="flex items-center gap-1.5">
            <span class="text-muted-foreground">{{
              t(mode === "remote" ? "workbench.desktop.forwards.bindHostServer" : "workbench.desktop.forwards.bindHost")
            }}</span>
            <input
              v-model="bindHost"
              type="text"
              spellcheck="false"
              class="w-28 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] focus:border-primary focus:outline-none"
            />
          </label>
          <label class="flex items-center gap-1.5">
            <span class="text-muted-foreground">{{
              t(mode === "remote" ? "workbench.desktop.forwards.bindPortServer" : "workbench.desktop.forwards.bindPort")
            }}</span>
            <input
              v-model="bindPort"
              type="text"
              inputmode="numeric"
              spellcheck="false"
              class="w-16 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] focus:border-primary focus:outline-none"
            />
          </label>
          <template v-if="mode === 'local' || mode === 'remote'">
            <label class="flex items-center gap-1.5">
              <span class="text-muted-foreground">{{
                t(
                  mode === "remote"
                    ? "workbench.desktop.forwards.targetHostLocal"
                    : "workbench.desktop.forwards.targetHost",
                )
              }}</span>
              <input
                v-model="targetHost"
                type="text"
                spellcheck="false"
                class="w-28 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] focus:border-primary focus:outline-none"
              />
            </label>
            <label class="flex items-center gap-1.5">
              <span class="text-muted-foreground">{{
                t(
                  mode === "remote"
                    ? "workbench.desktop.forwards.targetPortLocal"
                    : "workbench.desktop.forwards.targetPort",
                )
              }}</span>
              <input
                v-model="targetPort"
                type="text"
                inputmode="numeric"
                spellcheck="false"
                class="w-16 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] focus:border-primary focus:outline-none"
              />
            </label>
          </template>
        </div>

        <!-- The scenes, because "local forward" is a phrase and the need behind it is not. -->
        <div
          class="space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground"
        >
          <p>{{ t("workbench.desktop.forwards.hint.local") }}</p>
          <p>{{ t("workbench.desktop.forwards.hint.dynamic") }}</p>
          <p>{{ t("workbench.desktop.forwards.hint.remote") }}</p>
        </div>

        <p v-if="addFailure" class="text-[11px] text-destructive">
          {{ describeShellError(translate, addFailure).message }}
          <span class="font-mono text-[10px] text-muted-foreground">{{ addFailure.code }}</span>
        </p>

        <div class="flex items-center justify-end gap-2">
          <button
            type="submit"
            class="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!addOk || adding"
          >
            <Plus :size="12" />
            {{ t("workbench.desktop.forwards.add") }}
          </button>
        </div>
      </form>
    </template>

    <!--
      The questions this window asks, plainly: about the open the gate stopped for — a remote
      forward, a bind other machines could reach — and about the one write of stopping a forward
      somebody may have been using.
    -->
    <ConfirmDialog
      :open="askingOpen"
      :title="t('workbench.desktop.forwards.openAskTitle')"
      :message="t('workbench.desktop.forwards.openAskMessage')"
      :confirm-label="t('workbench.desktop.forwards.open')"
      danger
      @confirm="confirmOpen()"
      @update:open="
        (value: boolean) => {
          if (!value) dropOpen();
        }
      "
    />
    <ConfirmDialog
      :open="stopQuestion"
      :title="t('workbench.desktop.forwards.stopTitle')"
      :message="
        t('workbench.desktop.forwards.stopMessage', {
          bind: stopping ? `${stopping.bindHost}:${stopping.bindPort}` : '',
        })
      "
      :confirm-label="t('workbench.desktop.forwards.stop')"
      danger
      @confirm="confirmStop()"
      @update:open="
        (value: boolean) => {
          if (!value) dropQuestion();
        }
      "
    />
  </section>
</template>
