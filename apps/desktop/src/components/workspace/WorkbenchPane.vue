<script lang="ts">
/**
 * The backdrop ids the workbench knows how to draw, shared with the session editor that writes the
 * field. An id outside this list — and no id at all — draws the interface's own background, which
 * is what a document written before the field existed carries.
 */
export const WORKBENCH_WALLPAPER_IDS = ["aurora", "dawn", "forest", "plain"] as const;

export type WorkbenchWallpaperId = (typeof WORKBENCH_WALLPAPER_IDS)[number];
</script>

<script setup lang="ts">
/**
 * The desktop workbench: what a Linux desktop session opens as, instead of a terminal.
 *
 * The connection underneath is an ordinary SSH one, and everything this pane shows is a surface
 * that connection already carries — the system mark the open asked for once, the monitor's sample,
 * the file browser, the host's own pages. Nothing here opens a second connection: the entries are
 * ways of using the one the session has, which is why "open terminal" is a plain open (a second
 * connection to the same machine, as asking for another terminal anywhere is) and why closing the
 * workbench takes the file tabs riding its connection with it.
 *
 * The one thing this pane can ask the machine to *do* is the power action, and it is asked about
 * first: the buttons open the same plain confirmation every destructive action here uses, and the
 * acknowledgement that a person answered it is what travels with the command.
 *
 * The monitor is asked for while this pane is the tab on screen and not otherwise, the same rule
 * the host pages follow: a poll nobody can see is somebody else's machine paying for a feature
 * nobody is looking at.
 */
import {
  CircleAlert,
  ExternalLink,
  Folder,
  HardDrive,
  House,
  ListTree,
  LoaderCircle,
  Power,
  RotateCw,
  Terminal,
} from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import SystemIcon from "@/components/ui/SystemIcon.vue";
import { useToast } from "@/composables/useToast";
import { backend } from "@/lib/backend/api";
import { asShellError } from "@/lib/backend/errors";
import { describeShellError, type Translate } from "@/i18n/errors";
import { formatSize } from "@/lib/files/format";
import { sessionEndpoint } from "@/lib/menu/sessions";
import { memoryUsed, share } from "@/lib/monitor/rates";
import { systemLabel, systemMark } from "@/lib/system/icons";
import { rememberPath, readRecentPaths, writeRecentPaths } from "@/lib/workbench/recentPaths";
import { useFilesStore } from "@/stores/files";
import { useMonitorStore } from "@/stores/monitor";
import { type WorkbenchTab, useTerminalsStore } from "@/stores/terminals";
import type { DiskUsage } from "@/types/monitor";

const props = defineProps<{
  /** The tab this pane draws; its session is what everything here is about. */
  tab: WorkbenchTab;
  /** Whether this pane is the tab on screen, which is what starts and stops the sampling. */
  active: boolean;
}>();

const { t } = useI18n();
const terminals = useTerminalsStore();
const monitor = useMonitorStore();
const files = useFilesStore();
const { toast } = useToast();

function translate(key: string, params?: Record<string, string>): string {
  return params ? t(key, params) : t(key);
}

const session = computed(() => props.tab.session);
const connected = computed(() => props.tab.handle !== null && props.tab.failure === null);

const system = computed(() => terminals.systemOf(session.value));
const mark = computed(() => systemMark(system.value));
const osName = computed(() => systemLabel(system.value) ?? monitor.sample?.os ?? null);

/**
 * The backdrop the session asked for, or nothing for the interface's own background.
 *
 * An id this build does not draw is the same as no id: a document written elsewhere may carry a
 * name this version has never heard of, and guessing a picture would be drawing something the
 * person who saved it did not choose.
 */
const wallpaper = computed(() => {
  const wanted = session.value.workbench?.wallpaper;
  if (wanted === undefined || !WORKBENCH_WALLPAPER_IDS.includes(wanted as WorkbenchWallpaperId)) {
    return undefined;
  }
  return wanted;
});

const WALLPAPER_BACKDROPS: Readonly<Record<string, string>> = {
  aurora: "linear-gradient(165deg, #1e1b4b 0%, #312e81 45%, #155e75 100%)",
  dawn: "linear-gradient(165deg, #431407 0%, #9a3412 55%, #b45309 100%)",
  forest: "linear-gradient(165deg, #052e16 0%, #14532d 55%, #3f6212 100%)",
  plain: "",
};

const wallpaperStyle = computed(() => {
  const id = wallpaper.value;
  if (id === undefined) {
    return undefined;
  }
  return { background: WALLPAPER_BACKDROPS[id] };
});

// The pane is what asks for samples while it is the tab on screen, the way a host page is; the
// panel beside the workspace asks for its own.
watch(
  () => props.active,
  (active) => (active ? monitor.start() : monitor.stop()),
  { immediate: true },
);
onBeforeUnmount(() => {
  if (props.active) {
    monitor.stop();
  }
});

/** Whether the readings on screen are about this host, which is what a body draws. */
const live = computed(() => monitor.sampleSessionId === session.value.id);

const memory = computed(() => monitor.sample?.memory ?? null);
const memoryPercent = computed(() => (memory.value ? share(memoryUsed(memory.value), memory.value.totalBytes) : null));
const memoryText = computed(() =>
  memory.value ? `${formatSize(memoryUsed(memory.value))} / ${formatSize(memory.value.totalBytes)}` : null,
);

function diskUsage(disk: DiskUsage): number | null {
  return share(disk.sizeBytes - disk.availableBytes, disk.sizeBytes);
}

/** A reading somebody can read, or the dash that says nobody reported one. */
function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : `${Math.round(value)}%`;
}

// -- recently visited directories --------------------------------------------

/**
 * Where this session's browser has been, as last remembered.
 *
 * Read when the pane is drawn, and extended while it is: the browsers in the files store are
 * watched for their current path, because a browser's path changing *is* a visit — there is
 * nothing else to record and nobody to ask. Nothing here is a choice, which is why none of it
 * reaches the settings file.
 */
const recentPaths = ref<string[]>(readRecentPaths()[session.value.id] ?? []);

watch(
  () =>
    Object.values(files.browsers)
      .filter((browser) => browser.sessionId === session.value.id)
      .map((browser) => browser.path),
  (now, before) => {
    const remembered = recentPaths.value;
    let next = remembered;
    for (const path of now) {
      if (before?.includes(path) || next[0] === path) {
        continue;
      }
      next = rememberPath(next, path);
    }
    if (next !== remembered) {
      recentPaths.value = next;
      writeRecentPaths({ ...readRecentPaths(), [session.value.id]: next });
    }
  },
  { immediate: true },
);

// -- the entries -------------------------------------------------------------

/** A second connection to the same machine, as asking for another terminal anywhere is. */
function openTerminal(): void {
  void terminals.open(session.value);
}

function openFiles(path?: string): void {
  void terminals.openFiles(session.value, path);
}

function openMonitor(): void {
  terminals.openInspect("system", session.value);
}

// -- the power actions -------------------------------------------------------

const confirming = ref<"reboot" | "shutdown" | null>(null);

function confirmTitle(): string {
  return confirming.value === "reboot"
    ? t("workbench.power.rebootTitle", { name: session.value.name })
    : t("workbench.power.shutdownTitle", { name: session.value.name });
}

function confirmMessage(): string {
  return confirming.value === "reboot" ? t("workbench.power.rebootMessage") : t("workbench.power.shutdownMessage");
}

function confirmLabel(): string {
  return confirming.value === "reboot" ? t("workbench.power.rebootConfirm") : t("workbench.power.shutdownConfirm");
}

/**
 * Carries out what the confirmation was about, once somebody has answered it.
 *
 * The answer is the acknowledgement the policy gate acts on, which is why the call carries `true`
 * rather than a question: asking again would be asking twice about one answer. A machine that took
 * the connection down with it has had the command work, not fail — the backend answers that — so
 * the receipt here is only for a command that left.
 */
async function issuePower(): Promise<void> {
  const action = confirming.value;
  if (!action || props.tab.handle === null) {
    confirming.value = null;
    return;
  }
  confirming.value = null;
  try {
    await backend.workbenchPower(session.value.id, props.tab.handle, action, true);
    toast(t("workbench.power.issued"), "receipt");
  } catch (error) {
    const failure = asShellError(error, "workbench_power");
    toast(describeShellError(translate as Translate, failure).message, "failure");
  }
}
</script>

<template>
  <!--
    The backdrop is the pane's own, and the cards stay on the standard surface: a wallpaper behind
    standard cards is a backdrop, while one behind custom colours is a theme nobody asked to debug.
  -->
  <section class="flex min-h-0 flex-1 flex-col overflow-hidden" :style="wallpaperStyle">
    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <div class="mx-auto flex max-w-2xl flex-col gap-3">
        <!--
          The system card: what the machine said it is, and what it is doing right now. A reading
          the host did not report is drawn as a dash, never as a zero — the same rule the monitor
          panel follows, because a dash next to a number that means something is exactly the
          confusion a reading must not create.
        -->
        <section class="rounded-lg border border-border bg-card px-3 py-2.5" data-workbench-system>
          <header class="mb-2 flex items-center gap-2">
            <SystemIcon v-if="mark" :system="null" :mark="mark" :size="16" :label="osName ?? undefined" />
            <h3 class="text-xs font-medium">{{ t("workbench.system.title") }}</h3>
            <span class="flex-1"></span>
            <LoaderCircle v-if="active && monitor.sampling" :size="12" class="animate-spin text-muted-foreground" />
          </header>

          <dl class="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1 text-xs">
            <dt class="text-muted-foreground">{{ t("workbench.system.os") }}</dt>
            <dd class="truncate" :title="osName ?? undefined">{{ osName ?? "-" }}</dd>

            <dt class="text-muted-foreground">{{ t("workbench.system.hostname") }}</dt>
            <dd class="truncate font-mono">{{ monitor.sample?.hostname ?? "-" }}</dd>

            <dt class="text-muted-foreground">{{ t("workbench.system.address") }}</dt>
            <dd class="truncate font-mono">{{ sessionEndpoint(session, t) }}</dd>
          </dl>

          <!--
            The three readings, in the shape the monitor panel draws them: label, bar, percentage.
            The bar and the percentage are the same number, so a row without one has neither.
          -->
          <div class="mt-2.5 space-y-1.5 border-t border-border pt-2 text-xs">
            <div class="flex items-center gap-2" :title="t('monitor.cpuHint')">
              <span class="w-16 shrink-0 text-muted-foreground">{{ t("workbench.system.cpu") }}</span>
              <span class="h-2 min-w-0 flex-1 overflow-hidden rounded-sm bg-muted">
                <span
                  class="block h-full rounded-sm bg-primary/70"
                  :style="{ width: `${Math.min(Math.max(monitor.cpuPercent ?? 0, 0), 100)}%` }"
                />
              </span>
              <span class="w-10 shrink-0 text-right font-mono">{{ percent(monitor.cpuPercent) }}</span>
            </div>

            <div class="flex items-center gap-2">
              <span class="w-16 shrink-0 text-muted-foreground">{{ t("workbench.system.memory") }}</span>
              <span class="h-2 min-w-0 flex-1 overflow-hidden rounded-sm bg-muted">
                <span
                  class="block h-full rounded-sm bg-primary/70"
                  :style="{ width: `${Math.min(Math.max(memoryPercent ?? 0, 0), 100)}%` }"
                />
              </span>
              <span class="w-10 shrink-0 text-right font-mono">{{ percent(memoryPercent) }}</span>
              <span class="w-28 shrink-0 truncate text-right font-mono text-muted-foreground">
                {{ memoryText ?? "-" }}
              </span>
            </div>
          </div>

          <div class="mt-1.5 space-y-1 border-t border-border pt-2 text-xs">
            <div class="flex items-center gap-2">
              <HardDrive :size="12" class="shrink-0 text-muted-foreground" />
              <span class="w-14 shrink-0 text-muted-foreground">{{ t("workbench.system.disks") }}</span>
              <span
                v-if="!live || (monitor.sample?.disks.length ?? 0) === 0"
                class="min-w-0 flex-1 text-right font-mono"
              >
                {{ !live ? "-" : t("monitor.disks.empty") }}
              </span>
            </div>
            <div
              v-for="disk in monitor.sample?.disks ?? []"
              :key="`${disk.filesystem}:${disk.mountPoint}`"
              class="flex items-center gap-2 pl-[18px]"
              :title="disk.filesystem"
            >
              <span class="min-w-0 flex-1 truncate font-mono">{{ disk.mountPoint }}</span>
              <span class="shrink-0 font-mono text-muted-foreground">
                {{ formatSize(disk.availableBytes) }}/{{ formatSize(disk.sizeBytes) }}
              </span>
              <span class="w-10 shrink-0 text-right font-mono">{{ percent(diskUsage(disk)) }}</span>
            </div>
            <p v-if="!live" class="pl-[18px] text-[10px] text-muted-foreground">
              {{ t("workbench.system.waiting") }}
            </p>
          </div>
        </section>

        <!--
          The file area's entries: the session's own browser, and where it has been. Both open the
          browser the session already has — a path here is a place to be, not another connection.
        -->
        <section class="rounded-lg border border-border bg-card px-3 py-2.5" data-workbench-files>
          <h3 class="mb-2 text-xs font-medium">{{ t("workbench.files.title") }}</h3>
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent"
            @click="openFiles()"
          >
            <House :size="13" class="shrink-0 text-muted-foreground" />
            {{ t("workbench.files.home") }}
            <ExternalLink :size="11" class="ml-auto shrink-0 text-muted-foreground" />
          </button>

          <p class="mt-2 px-2 text-[10px] tracking-wide text-muted-foreground uppercase">
            {{ t("workbench.files.recent") }}
          </p>
          <button
            v-for="path in recentPaths"
            :key="path"
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
            :title="path"
            @click="openFiles(path)"
          >
            <Folder :size="13" class="shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate font-mono">{{ path }}</span>
          </button>
          <p v-if="recentPaths.length === 0" class="px-2 py-1 text-[11px] text-muted-foreground">
            {{ t("workbench.files.recentEmpty") }}
          </p>
        </section>

        <!--
          The session card, and the entries: every one of them uses the connection this session has
          or asks for one in a shape the session already opens in. None of them open anything the
          session does not already have a door for.
        -->
        <section class="rounded-lg border border-border bg-card px-3 py-2.5" data-workbench-session>
          <header class="mb-2 flex items-center gap-2">
            <h3 class="text-xs font-medium">{{ t("workbench.session.title") }}</h3>
            <span
              class="ml-auto flex items-center gap-1.5 text-[11px]"
              :class="connected ? 'text-success' : 'text-muted-foreground'"
            >
              <CircleAlert v-if="!connected" :size="12" class="text-warning" />
              {{ connected ? t("workbench.session.connected") : t("workbench.session.disconnected") }}
            </span>
          </header>

          <dl class="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1 text-xs">
            <dt class="text-muted-foreground">{{ t("workbench.session.address") }}</dt>
            <dd class="truncate font-mono">{{ session.user }}@{{ session.host }}:{{ session.port }}</dd>
          </dl>

          <div class="mt-2.5 flex flex-wrap gap-1.5 border-t border-border pt-2.5">
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-accent"
              @click="openTerminal()"
            >
              <Terminal :size="13" />
              {{ t("workbench.entry.terminal") }}
            </button>
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-accent"
              @click="openFiles()"
            >
              <Folder :size="13" />
              {{ t("workbench.entry.files") }}
            </button>
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-accent"
              @click="openMonitor()"
            >
              <ListTree :size="13" />
              {{ t("workbench.entry.monitor") }}
            </button>
          </div>
        </section>

        <!--
          The power actions, behind the same plain confirmation every destructive action here uses:
          the title is the action, the message is the consequence, and the button is the verb again.
        -->
        <section class="rounded-lg border border-border bg-card px-3 py-2.5" data-workbench-power>
          <h3 class="mb-2 text-xs font-medium">{{ t("workbench.power.title") }}</h3>
          <div class="flex gap-1.5">
            <button
              type="button"
              :disabled="!connected"
              class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              @click="confirming = 'reboot'"
            >
              <RotateCw :size="13" />
              {{ t("workbench.power.reboot") }}
            </button>
            <button
              type="button"
              :disabled="!connected"
              class="flex items-center gap-1.5 rounded-md border border-destructive/50 px-2.5 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              @click="confirming = 'shutdown'"
            >
              <Power :size="13" />
              {{ t("workbench.power.shutdown") }}
            </button>
          </div>
        </section>
      </div>
    </div>

    <ConfirmDialog
      :open="confirming !== null"
      :title="confirmTitle()"
      :message="confirmMessage()"
      :confirm-label="confirmLabel()"
      danger
      @confirm="issuePower()"
      @update:open="confirming = null"
    />
  </section>
</template>
