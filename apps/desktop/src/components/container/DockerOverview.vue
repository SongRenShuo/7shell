<script setup lang="ts">
/**
 * The Docker window's overview page: what the engine holds, whether it is well, and how hard it is
 * working — the page the reference opens its Docker manager onto.
 *
 * Three rows say what the engine holds, and each row is the page it summarizes: a click is a jump,
 * because a number that cannot be pressed is a number somebody has to go and find. The three
 * short lines below are the engine working — CPU, memory, network — sampled every five seconds
 * from the stats call the workspace already makes, and drawn without animation: a live chart is
 * data arriving, not a transition.
 *
 * The sampling has the discipline the monitor's panel taught: nobody watching, nothing sampled.
 * The window reports whether it is the one in front, and the document reports whether it is
 * visible at all; both have to say yes before the engine is asked anything.
 */
import { Boxes, CircleAlert, Layers } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { formatSize } from "@/lib/files/format";
import { backend } from "@/lib/backend/api";
import type { ContainerTab } from "@/stores/terminals";
import type { ContainerSession } from "@/stores/container";

import StatSparkline from "./StatSparkline.vue";
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
  () => props.session.containers.filter((c) => c.state === "dead" || c.state === "error").length,
);

const healthy = computed(() => engineHealthy(props.session.containers.map((c) => c.state)));

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
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3" data-docker-overview>
    <!--
      The summary: three rows, each the page it counts. the reference draws these as rows rather than cards,
      and the difference matters — a card invites decorating, a row invites pressing.
    -->
    <div class="flex flex-col" data-docker-overview-summary>
      <button
        type="button"
        data-docker-summary-containers
        class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-[color-mix(in_srgb,var(--workbench-on-picture)_6%,transparent)]"
        @click="emit('show-state', '')"
      >
        <Boxes :size="14" class="shrink-0 text-muted-foreground" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate">
          {{
            t("container.desktop.summary.containers", { total: String(containersTotal), running: String(runningCount) })
          }}
        </span>
      </button>
      <button
        type="button"
        data-docker-summary-images
        class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-[color-mix(in_srgb,var(--workbench-on-picture)_6%,transparent)]"
        @click="emit('show-images')"
      >
        <Layers :size="14" class="shrink-0 text-muted-foreground" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate">
          {{ t("container.desktop.summary.images", { total: String(imagesTotal) }) }}
        </span>
      </button>
      <button
        type="button"
        data-docker-summary-abnormal
        class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-[color-mix(in_srgb,var(--workbench-on-picture)_6%,transparent)]"
        @click="emit('show-state', 'dead')"
      >
        <CircleAlert :size="14" class="shrink-0 text-muted-foreground" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate">
          {{ t("container.desktop.summary.abnormal", { count: String(abnormalCount) }) }}
        </span>
      </button>
    </div>

    <!-- The lamp: one line saying whether the engine is well, with the dot in its colour. -->
    <p class="flex items-center gap-2 px-2 text-xs" data-docker-overview-health>
      <span
        class="size-1.5 shrink-0 rounded-full"
        :class="healthy ? 'bg-success' : 'bg-destructive'"
        aria-hidden="true"
      ></span>
      <span class="text-muted-foreground">
        {{ healthy ? t("container.desktop.health.healthy") : t("container.desktop.health.unhealthy") }}
      </span>
    </p>

    <!--
      The three lines. Each is drawn at the the reference mini chart's measure, from the series this page
      has sampled — the shell is `StatSparkline`, shared with a single container's monitor.
    -->
    <div class="grid grid-cols-[repeat(auto-fit,minmax(18rem,1fr))] gap-3" data-docker-overview-charts>
      <StatSparkline
        data-docker-chart-cpu
        :label="t('container.desktop.chart.cpu')"
        :values="cpuSeries"
        tone="accent"
      />
      <StatSparkline
        data-docker-chart-memory
        :label="t('container.desktop.chart.memory')"
        :values="memorySeries"
        tone="success"
      />
      <StatSparkline
        data-docker-chart-network
        :label="t('container.desktop.chart.network')"
        :values="netSeries"
        tone="warning"
        :value="netLabel()"
      />
    </div>
  </div>
</template>
