<script setup lang="ts">
/**
 * The Docker window's overview page: what the engine holds, whether it is well, and how hard it is
 * working — the page the reference Docker manager opens onto.
 *
 * Three tiles say what the engine holds, and each tile is the page it summarizes: a click is a
 * jump, because a number that cannot be pressed is a number somebody has to go and find. The
 * engine-health tile carries the verdict the page's lamp used to say beside the rows — its count
 * is how many containers are not well, its tier the lamp's colour. The three short lines below
 * are the engine working — CPU, memory, network — sampled every five seconds from the stats call
 * the workspace already makes, each titled with its newest reading, and drawn without animation:
 * a live chart is data arriving, not a transition.
 *
 * The sampling has the discipline the monitor's panel taught: nobody watching, nothing sampled.
 * The window reports whether it is the one in front, and the document reports whether it is
 * visible at all; both have to say yes before the engine is asked anything.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { formatSize } from "@/lib/files/format";
import { backend } from "@/lib/backend/api";
import type { ContainerTab } from "@/stores/terminals";
import type { ContainerSession } from "@/stores/container";

import SparkArea from "@/components/charts/SparkArea.vue";
import StatTile from "@/components/charts/StatTile.vue";
import { usageTone } from "@/components/charts/tone";

import { SAMPLE_INTERVAL_MS, SERIES_POINTS, aggregateStats, engineHealthy, netRate } from "./dockerMetrics";

const props = defineProps<{ tab: ContainerTab; session: ContainerSession; active: boolean }>();

const emit = defineEmits<{
  /** The containers row was pressed: the pane shows the container list, filtered if a state was named. */
  "show-state": [state: string];
  /** The images row was pressed: the pane shows the image list. */
  "show-images": [];
}>();

const { t } = useI18n();

const containersTotal = computed(() => props.session.info?.containersTotal ?? props.session.containers.length);
const runningCount = computed(() => props.session.containers.filter((c) => c.state === "running").length);
const imagesTotal = computed(() => props.session.info?.imagesTotal ?? props.session.images.length);
const abnormalCount = computed(
  () =>
    props.session.containers.filter(
      (c) => c.state === "dead" || c.state === "error" || (c.state === "running" && c.health === "unhealthy"),
    ).length,
);

const healthy = computed(() => engineHealthy(props.session.containers));

// -- the three series ---------------------------------------------------------

const cpuSeries = ref<number[]>([]);
const memorySeries = ref<number[]>([]);
const netSeries = ref<number[]>([]);

/** The latest network rate, for the number beside the line. */
const netRateNow = ref<number | null>(null);

function push(series: number[], value: number): void {
  series.push(value);
  if (series.length > SERIES_POINTS) {
    series.shift();
  }
}

let previousNetBytes: number | null = null;
let previousAt: number | null = null;

async function sampleOnce(): Promise<void> {
  const connectionId = props.session.connectionId;
  if (connectionId === null) {
    return;
  }
  try {
    const stats = await backend.containers.stats(connectionId);
    const totals = aggregateStats(stats);
    const now = Date.now();
    const seconds = previousAt === null ? SAMPLE_INTERVAL_MS / 1000 : (now - previousAt) / 1000;
    const rate = netRate(totals.netBytes, previousNetBytes, seconds);
    previousNetBytes = totals.netBytes;
    previousAt = now;
    push(cpuSeries.value, totals.cpuPercent);
    push(memorySeries.value, totals.memoryPercent);
    push(netSeries.value, rate);
    netRateNow.value = rate;
  } catch {
    // The engine did not answer this once. The next tick tries again; the lines keep what they have.
  }
}

// -- sampling only while somebody is looking -----------------------------------

let timer: ReturnType<typeof setInterval> | null = null;

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
  if (document.visibilityState === "visible") {
    void sampleOnce();
    startSampling();
    return;
  }
  stopSampling();
}

watch(
  () => props.active,
  (active) => {
    if (active) {
      void sampleOnce();
      startSampling();
      return;
    }
    stopSampling();
  },
);

onMounted(() => {
  document.addEventListener("visibilitychange", onVisibilityChange);
  // The same rule the interval keeps: a window that is not in front does not sample on arrival
  // either. When it becomes the one in front, the watch starts the work.
  if (props.active && document.visibilityState === "visible") {
    void sampleOnce();
    startSampling();
  }
});

onBeforeUnmount(() => {
  stopSampling();
  document.removeEventListener("visibilitychange", onVisibilityChange);
});

function netLabel(): string {
  const rate = netRateNow.value;
  return rate === null ? "—" : `${formatSize(rate)}/s`;
}

/** The newest sample a series holds, or nothing when the engine has not answered yet. */
function latestOf(series: readonly number[]): number | null {
  return series.length === 0 ? null : (series[series.length - 1] ?? null);
}

/** The readings beside the chart titles: each series' newest sample, with its unit. */
const cpuReading = computed(() => {
  const latest = latestOf(cpuSeries.value);
  return latest === null ? "—" : `${latest.toFixed(1)}%`;
});

const memoryReading = computed(() => {
  const latest = latestOf(memorySeries.value);
  return latest === null ? "—" : `${latest.toFixed(1)}%`;
});

/**
 * The memory line wears the tier the desktops share, from the reading it has just drawn: memory is
 * the one series here that is a usage. A rate has no ninety, so the network line keeps its own
 * series colour, and CPU keeps the accent — thresholds that are not usages would be decoration.
 */
const memoryTone = computed<"ok" | "warn" | "danger">(() => {
  const latest = memorySeries.value[memorySeries.value.length - 1];
  return latest === undefined ? "ok" : usageTone(latest);
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3" data-docker-overview>
    <!--
      The summary: three tiles, each the page it counts. The reference reads these at a glance — a
      big number over its name — and each tile stays a button, because a number that cannot be
      pressed is a number somebody has to go and find. The engine-health tile carries the lamp the
      page used to draw beside the rows: its count is the engine's verdict, its tier is the lamp's
      colour, and its tooltip says the sentence out loud.
    -->
    <div class="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3" data-docker-overview-summary>
      <button
        type="button"
        data-docker-summary-containers
        class="block w-full cursor-pointer text-left transition-opacity hover:opacity-80"
        @click="emit('show-state', '')"
      >
        <StatTile
          :label="t('container.desktop.tile.containers', { running: String(runningCount) })"
          :value="String(containersTotal)"
        />
      </button>
      <button
        type="button"
        data-docker-summary-images
        class="block w-full cursor-pointer text-left transition-opacity hover:opacity-80"
        @click="emit('show-images')"
      >
        <StatTile :label="t('container.desktop.tile.images')" :value="String(imagesTotal)" />
      </button>
      <button
        type="button"
        data-docker-summary-abnormal
        class="block w-full cursor-pointer text-left transition-opacity hover:opacity-80"
        :title="healthy ? t('container.desktop.health.healthy') : t('container.desktop.health.unhealthy')"
        @click="emit('show-state', 'dead')"
      >
        <StatTile
          :label="t('container.desktop.tile.engine')"
          :value="String(abnormalCount)"
          :tone="abnormalCount > 0 ? 'danger' : undefined"
        />
      </button>
    </div>

    <!--
      The three lines. Each is drawn at the reference mini chart's measure, from the series this
      page has sampled — the shell is `SparkArea`, shared with a single container's monitor, and it
      draws the samples as an area rather than a line: the samples are intervals, not a continuum.
      Each title carries its series' newest reading with its unit, the way the reference's stat
      graphs do; the network's is a rate, and says so with the `/s`.
    -->
    <div class="grid grid-cols-[repeat(auto-fit,minmax(18rem,1fr))] gap-3" data-docker-overview-charts>
      <SparkArea
        data-docker-chart-cpu
        :label="t('container.desktop.chart.cpu')"
        :values="cpuSeries"
        tone="accent"
        :value="cpuReading"
      />
      <SparkArea
        data-docker-chart-memory
        :label="t('container.desktop.chart.memory')"
        :values="memorySeries"
        :tone="memoryTone"
        :value="memoryReading"
      />
      <SparkArea
        data-docker-chart-network
        :label="t('container.desktop.chart.network')"
        :values="netSeries"
        tone="warn"
        :value="netLabel()"
      />
    </div>
  </div>
</template>
