<script setup lang="ts">
/**
 * The widgets column: the machine's vitals, on the desk beside the icons.
 *
 * Four cards — the machine's name and its uptime, the CPU's busy share, the network's current
 * rate, and the storage's fill — each one a button, because a widget that only displays is a
 * dead end: the readings point at the windows that can explain them, so pressing one opens the
 * monitor (or, for storage, the system panel's disk tree) rather than doing nothing.
 *
 * The readings come from the same sampler the monitor page uses, over the connection the desktop
 * already holds. The discipline is the one the monitor taught: nobody watching, no sampling. The
 * pump runs only while this desktop is the tab on screen *and* the application window is visible
 * — a desktop that went to another tab, or an application somebody minimised, costs nothing but a
 * stopped timer. Rates (CPU, network) need two samples a known distance apart; the first frame
 * after a pause shows the level readings and waits for the next tick to say a rate, which is
 * honest — a rate made from a stale previous sample would be a number about nothing.
 *
 * The enabled set is handed in; what it means and where it lives is the pane's business.
 */
import { Cpu, HardDrive, House, Wifi } from "@lucide/vue";
import type { Component } from "vue";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { backend } from "@/lib/backend/api";
import { usageTone, type WorkbenchWidgetId } from "@/lib/workbench/desktopWidgets";
import type { HostMetrics } from "@/types/monitor";

const props = defineProps<{
  /** The connection handle the readings ride on; null means nothing to sample. */
  handle: string | null;
  /** Whether this desktop is the tab on screen. A hidden desktop reads nothing. */
  active: boolean;
  /** Which widgets the person keeps, in the order the column draws them. */
  enabled: WorkbenchWidgetId[];
}>();

const emit = defineEmits<{
  /** A widget was pressed: open the window that can explain this reading. */
  open: [target: "monitor" | "system"];
}>();

const { t } = useI18n();

/** How often the machine is asked, while somebody is watching. */
const SAMPLE_INTERVAL_MS = 2_000;

const latest = ref<HostMetrics | null>(null);
const previous = ref<HostMetrics | null>(null);
let ticker: ReturnType<typeof setInterval> | undefined;
let onVisibility: (() => void) | undefined;

function visible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/** Whether the pump should be running: a watching desktop, a live handle, a visible application. */
function shouldPump(): boolean {
  return props.active && props.handle !== null && visible();
}

async function sample(): Promise<void> {
  const handle = props.handle;
  if (handle === null) {
    return;
  }
  try {
    const next = await backend.monitor.sample(handle);
    previous.value = latest.value;
    latest.value = next;
  } catch {
    // A sample that failed leaves the last readings on the desk: a widget that blinked away on a
    // hiccup would be a widget less useful than no widget.
  }
}

function startPump(): void {
  if (ticker !== undefined || !shouldPump()) {
    return;
  }
  void sample();
  ticker = setInterval(() => {
    void sample();
  }, SAMPLE_INTERVAL_MS);
}

function stopPump(): void {
  if (ticker !== undefined) {
    clearInterval(ticker);
    ticker = undefined;
  }
}

watch(
  () => [props.active, props.handle],
  () => {
    if (shouldPump()) {
      startPump();
    } else {
      stopPump();
    }
  },
);

onMounted(() => {
  if (shouldPump()) {
    startPump();
  }
  onVisibility = () => {
    if (shouldPump()) {
      startPump();
    } else {
      stopPump();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
});

onUnmounted(() => {
  stopPump();
  if (onVisibility !== undefined) {
    document.removeEventListener("visibilitychange", onVisibility);
    onVisibility = undefined;
  }
});

/** Seconds of uptime, said the way a desk widget can: days, hours, minutes. */
const uptime = computed(() => {
  const seconds = latest.value?.uptimeSeconds;
  if (seconds === null || seconds === undefined) {
    return null;
  }
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) {
    return t("workbench.desktop.widgets.uptimeDays", { days, hours });
  }
  return t("workbench.desktop.widgets.uptimeHours", { hours, minutes });
});

/** The load average the desk says, to one place: the five-minute figure is the one that means. */
const load = computed(() => {
  const five = latest.value?.load?.five;
  return five === null || five === undefined ? null : five.toFixed(1);
});

/**
 * The CPU's busy share, from the tick counters two samples apart.
 *
 * A rate needs a known distance between the counters; with one sample there is no distance yet, and
 * the card waits rather than inventing one.
 */
const cpuPercent = computed(() => {
  const now = latest.value?.cpu;
  const before = previous.value?.cpu;
  if (now === null || now === undefined || before === null || before === undefined) {
    return null;
  }
  const totalDelta = now.totalTicks - before.totalTicks;
  const idleDelta = now.idleTicks - before.idleTicks;
  if (totalDelta <= 0) {
    return null;
  }
  const busy = totalDelta - idleDelta;
  return Math.min(100, Math.max(0, Math.round((busy / totalDelta) * 100)));
});

/**
 * Bytes per second across the machine's real interfaces, from the counters two samples apart.
 *
 * Loopback is traffic talking to itself — a widget that counted it would show a busy machine
 * whenever something used the Docker bridge — so it is left out, the way the monitor page leaves
 * it out of its per-interface list.
 */
function ratesOf(now: HostMetrics, before: HostMetrics): { received: number; sent: number } | null {
  const seconds = (now.sampledAt - before.sampledAt) / 1000;
  if (seconds <= 0) {
    return null;
  }
  // The baseline is the *previous* sample's counters: the delta is now minus was, per interface,
  // and an interface the previous sample never saw contributes its whole count — arriving mid-walk.
  const was = new Map(before.network.map((entry) => [entry.name, entry]));
  let received = 0;
  let sent = 0;
  for (const entry of now.network) {
    if (entry.name === "lo") {
      continue;
    }
    const baseline = was.get(entry.name);
    const baselineReceived = baseline?.receivedBytes ?? 0;
    const baselineSent = baseline?.transmittedBytes ?? 0;
    received += Math.max(0, entry.receivedBytes - baselineReceived);
    sent += Math.max(0, entry.transmittedBytes - baselineSent);
  }
  return { received: Math.round(received / seconds), sent: Math.round(sent / seconds) };
}

const netRates = computed(() => {
  const now = latest.value;
  const before = previous.value;
  if (now === null || before === null) {
    return null;
  }
  return ratesOf(now, before);
});

/** The fullest real filesystem's usage, which is what a storage widget means on a server. */
const storage = computed(() => {
  const disks = latest.value?.disks ?? [];
  const real = disks.filter((disk) => disk.sizeBytes > 0);
  const fullest = real.reduce(
    (best, disk) => {
      const used = (disk.sizeBytes - disk.availableBytes) / disk.sizeBytes;
      return used > best.used ? { used, size: disk.sizeBytes, available: disk.availableBytes } : best;
    },
    { used: -1, size: 0, available: 0 },
  );
  if (fullest.used < 0) {
    return null;
  }
  return {
    percent: Math.round(fullest.used * 100),
    tone: usageTone(Math.round(fullest.used * 100)),
    size: fullest.size,
    available: fullest.available,
  };
});

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  }
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  if (bytes >= 1_000) {
    return `${(bytes / 1_000).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

interface WidgetCard {
  readonly id: WorkbenchWidgetId;
  readonly icon: Component;
  readonly title: string;
  readonly lines: { label: string; value: string; tone?: "ok" | "warn" | "danger" }[];
}

const cards = computed<WidgetCard[]>(() => {
  const drawn: WidgetCard[] = [];
  if (props.enabled.includes("system")) {
    drawn.push({
      id: "system",
      icon: House,
      title: t("workbench.desktop.widgets.system"),
      lines: [
        { label: t("workbench.desktop.widgets.host"), value: latest.value?.hostname ?? "—" },
        { label: t("workbench.desktop.widgets.uptime"), value: uptime.value ?? "—" },
        { label: t("workbench.desktop.widgets.load"), value: load.value ?? "—" },
      ],
    });
  }
  if (props.enabled.includes("cpu")) {
    drawn.push({
      id: "cpu",
      icon: Cpu,
      title: t("workbench.desktop.widgets.cpu"),
      lines: [
        {
          label: t("workbench.desktop.widgets.busy"),
          value: cpuPercent.value === null ? "—" : `${cpuPercent.value}%`,
        },
        {
          label: t("workbench.desktop.widgets.cores"),
          value: latest.value?.cores === undefined ? "—" : `${latest.value.cores}`,
        },
      ],
    });
  }
  if (props.enabled.includes("net")) {
    drawn.push({
      id: "net",
      icon: Wifi,
      title: t("workbench.desktop.widgets.net"),
      lines: [
        {
          label: t("workbench.desktop.widgets.down"),
          value: netRates.value === null ? "—" : `${formatBytes(netRates.value.received)}/s`,
        },
        {
          label: t("workbench.desktop.widgets.up"),
          value: netRates.value === null ? "—" : `${formatBytes(netRates.value.sent)}/s`,
        },
      ],
    });
  }
  if (props.enabled.includes("storage")) {
    drawn.push({
      id: "storage",
      icon: HardDrive,
      title: t("workbench.desktop.widgets.storage"),
      lines: [
        {
          label: t("workbench.desktop.widgets.used"),
          value: storage.value === null ? "—" : `${storage.value.percent}%`,
          tone: storage.value?.tone,
        },
        {
          label: t("workbench.desktop.widgets.free"),
          value: storage.value === null ? "—" : formatBytes(storage.value.available),
        },
      ],
    });
  }
  return drawn;
});

/** Where a widget's press lands: the storage card wants the disk tree, the rest the monitor. */
function targetOf(id: WorkbenchWidgetId): "monitor" | "system" {
  return id === "storage" ? "system" : "monitor";
}
</script>

<template>
  <aside
    v-if="cards.length > 0"
    data-workbench-widgets
    class="widgets"
    :aria-label="t('workbench.desktop.widgets.title')"
  >
    <button
      v-for="card in cards"
      :key="card.id"
      type="button"
      :data-widget-id="card.id"
      class="widget"
      :title="card.title"
      :aria-label="card.title"
      @click="emit('open', targetOf(card.id))"
    >
      <span class="widget-head">
        <component :is="card.icon" :size="14" />
        <span class="widget-title">{{ card.title }}</span>
      </span>
      <span v-for="line in card.lines" :key="line.label" class="widget-line">
        <span class="widget-label">{{ line.label }}</span>
        <span
          class="widget-value"
          :class="line.tone === 'warn' ? 'is-warn' : line.tone === 'danger' ? 'is-danger' : undefined"
          >{{ line.value }}</span
        >
      </span>
    </button>
  </aside>
</template>

<style scoped>
/*
 * The column sits on the desk the way the icons do: below the windows in stacking (no z of its
 * own — the windows carry the numbers), out of the click path when nobody is over it, and glass
 * like every other piece of chrome. The cards are the clickable things; the column itself never
 * catches a press meant for the wallpaper behind it.
 */
.widgets {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  width: 13rem;
  flex-direction: column;
  gap: 8px;
}

.widget {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--workbench-surface-1);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--workbench-glass-border);
  color: var(--workbench-on-picture);
  text-align: left;
  transition: background-color var(--wb-dur-base);
  cursor: pointer;
}

.widget:hover {
  background: var(--workbench-surface-2);
}

.widget:focus-visible {
  outline: 1px solid var(--workbench-focus-outline);
  outline-offset: -1px;
}

.widget-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
  color: var(--workbench-on-picture-muted);
}

.widget-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.widget-line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.widget-label {
  color: var(--workbench-on-picture-muted);
  font-size: 11px;
}

.widget-value {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/* The thresholds the desktops share: 90-95 wears amber, past 95 wears red. */
.widget-value.is-warn {
  color: var(--workbench-warning);
}

.widget-value.is-danger {
  color: var(--workbench-danger);
}
</style>
