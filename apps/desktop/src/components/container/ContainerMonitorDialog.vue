<script setup lang="ts">
/**
 * One container's own lines: processor, memory and network, sampled while somebody is looking.
 *
 * The reference manager gives every container a monitor of its own, and the engine already answers
 * per-container stats — the overview's aggregate is the same call with the rows summed, so this
 * page draws the row it was opened for and nothing else.
 *
 * The sampling discipline is the overview's, taught by the monitor panel before it: nobody
 * watching, nothing sampled. The dialog has to be open, the window has to be the one in front, and
 * the document has to be visible; only then is the engine asked. A rate needs two samples a known
 * distance apart, and the distance is measured, not assumed — the first tick after a pause is
 * longer than the interval and must not read as a spike.
 */
import { LoaderCircle, X } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { formatSize } from "@/lib/files/format";
import { backend } from "@/lib/backend/api";
import type { ContainerSession } from "@/stores/container";
import type { ContainerStats, ContainerSummary } from "@/types/container";

import SparkArea from "@/components/charts/SparkArea.vue";
import { usageTone } from "@/components/charts/tone";

import { SAMPLE_INTERVAL_MS, SERIES_POINTS, netRate } from "./dockerMetrics";

const props = defineProps<{
  open: boolean;
  session: ContainerSession;
  target: ContainerSummary | null;
  /** Whether the window this dialog lives in is the one in front. */
  active: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

const cpuSeries = ref<number[]>([]);
const memorySeries = ref<number[]>([]);
const netSeries = ref<number[]>([]);
const netRateNow = ref<number | null>(null);
/** Whether a sample has arrived at all — what separates "waiting" from "a flat line at zero". */
const sampled = ref(false);

let previousBytes: number | null = null;
let previousAt: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function push(series: number[], value: number): void {
  series.push(value);
  if (series.length > SERIES_POINTS) {
    series.shift();
  }
}

function reset(): void {
  cpuSeries.value = [];
  memorySeries.value = [];
  netSeries.value = [];
  netRateNow.value = null;
  sampled.value = false;
  previousBytes = null;
  previousAt = null;
}

/** The row this dialog is about, out of the stats the engine answered for the whole engine. */
function rowFor(stats: readonly ContainerStats[]): ContainerStats | null {
  const target = props.target;
  if (target === null) {
    return null;
  }
  return stats.find((row) => row.id === target.id || row.name === target.name) ?? null;
}

async function sampleOnce(): Promise<void> {
  const connectionId = props.session.connectionId;
  if (connectionId === null || props.target === null) {
    return;
  }
  try {
    const stats = await backend.containers.stats(connectionId);
    const row = rowFor(stats);
    if (row === null) {
      return;
    }
    const now = Date.now();
    const seconds = previousAt === null ? SAMPLE_INTERVAL_MS / 1000 : (now - previousAt) / 1000;
    const bytes = row.networkInput + row.networkOutput;
    const rate = netRate(bytes, previousBytes, seconds);
    previousBytes = bytes;
    previousAt = now;
    push(cpuSeries.value, row.cpuPercent);
    push(memorySeries.value, row.memoryPercent);
    push(netSeries.value, rate);
    netRateNow.value = rate;
    sampled.value = true;
  } catch {
    // The engine did not answer this once. The next tick tries again; the lines keep what they have.
  }
}

function startSampling(): void {
  if (timer !== null) {
    return;
  }
  timer = setInterval(() => {
    if (document.visibilityState === "visible") {
      void sampleOnce();
    }
  }, SAMPLE_INTERVAL_MS);
}

function stopSampling(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible" && props.open && props.active) {
    void sampleOnce();
    startSampling();
    return;
  }
  stopSampling();
}

/** Sampling runs only while the dialog is open, in front, and on a visible page. */
watch(
  () => [props.open, props.active] as const,
  ([open, active]) => {
    if (open && active && document.visibilityState === "visible") {
      void sampleOnce();
      startSampling();
      return;
    }
    stopSampling();
  },
  { immediate: true },
);

/** A different container is a different set of lines: the series starts over with it. */
watch(
  () => props.target?.id,
  () => {
    reset();
    if (props.open && props.active && document.visibilityState === "visible") {
      void sampleOnce();
    }
  },
);

watch(
  () => props.open,
  (open) => {
    if (!open) {
      stopSampling();
      reset();
    }
  },
);

document.addEventListener("visibilitychange", onVisibilityChange);

onBeforeUnmount(() => {
  stopSampling();
  document.removeEventListener("visibilitychange", onVisibilityChange);
});

const title = computed(() => (props.target === null ? "" : t("container.monitor.title", { name: props.target.name })));

function netLabel(): string {
  const rate = netRateNow.value;
  return rate === null ? "—" : `${formatSize(rate)}/s`;
}

/**
 * The memory line wears the tier the desktops share, from the reading it has just drawn — the one
 * series here that is a usage. The overview's own line follows the same rule, so a container and
 * its engine disagree only in numbers, never in what the colours mean.
 */
const memoryTone = computed<"ok" | "warn" | "danger">(() => {
  const latest = memorySeries.value[memorySeries.value.length - 1];
  return latest === undefined ? "ok" : usageTone(latest);
});
</script>

<template>
  <div v-if="open && target !== null" class="absolute inset-0 z-20 grid place-items-center" @click.self="emit('close')">
    <div
      class="flex w-[min(56rem,92%)] flex-col rounded-md border border-border bg-card shadow-xl"
      role="dialog"
      :aria-label="title"
      data-container-monitor
    >
      <header class="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span class="min-w-0 truncate text-xs font-medium" :title="title">{{ title }}</span>
        <button
          type="button"
          class="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          :title="t('common.action.close')"
          :aria-label="t('common.action.close')"
          data-container-monitor-close
          @click="emit('close')"
        >
          <X :size="12" />
        </button>
      </header>

      <div class="p-3">
        <p
          v-if="!sampled"
          class="flex items-center gap-1.5 text-[11px] text-muted-foreground"
          data-container-monitor-waiting
        >
          <LoaderCircle :size="12" class="animate-spin" />
          {{ t("container.monitor.waiting") }}
        </p>
        <div class="grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-3">
          <SparkArea data-container-monitor-cpu :label="t('container.monitor.cpu')" :values="cpuSeries" tone="accent" />
          <SparkArea
            data-container-monitor-memory
            :label="t('container.monitor.memory')"
            :values="memorySeries"
            :tone="memoryTone"
          />
          <SparkArea
            data-container-monitor-network
            :label="t('container.monitor.network')"
            :values="netSeries"
            tone="warn"
            :value="netLabel()"
          />
        </div>
      </div>
    </div>
  </div>
</template>
