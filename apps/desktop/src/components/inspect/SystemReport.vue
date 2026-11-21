<script setup lang="ts">
/**
 * What one host is, and how it is running right now.
 *
 * The first screen answers "how is this machine now": a band of readings under the host's name,
 * and the two charts — processor, memory — that show the last few minutes at a glance. The static
 * detail of what the machine *is* — kernel, architecture, the processor model — keeps its place
 * below, because "what am I logged into" is asked once rather than every two seconds, and a
 * first screen that opens on it opens on the least changing part of the page.
 *
 * Everything on it comes from the same sample the panel reads — there is no second command behind
 * this page — so a number here and a number there are the same reading, not two that agree by
 * luck. The charts eat the store's own history buffers, which grow only while samples arrive: a
 * window nobody looks at draws a chart that stands still, not one that quietly invents a flat
 * past for the time nobody watched.
 *
 * The page wears three bodies. Until the host answers and nothing has failed yet, a skeleton
 * stands in the shape of what is coming — the first read only, never a regression once a reading
 * has been drawn. When there is no reading and none arriving, the empty state says so and offers
 * the retry. Everything else is the page itself.
 */
import { RotateCw } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import MiniBar from "@/components/charts/MiniBar.vue";
import RingGauge from "@/components/charts/RingGauge.vue";
import SparkArea from "@/components/charts/SparkArea.vue";
import StatTile from "@/components/charts/StatTile.vue";
import { TONE_TOKENS, usageTone } from "@/components/charts/tone";
import InterfaceTable from "@/components/inspect/InterfaceTable.vue";
import { formatSize } from "@/lib/files/format";
import { UNKNOWN, orUnknown, percentOf, uptime } from "@/lib/monitor/format";
import { CPU_STATE_LABELS, memoryUsed, share, swapUsed } from "@/lib/monitor/rates";
import { TABLE, rowClass } from "@/lib/table";
import { useMonitorStore } from "@/stores/monitor";
import type { DiskUsage } from "@/types/monitor";

const props = defineProps<{
  /** Whether there is a sample to draw. A page with none still draws its waiting body. */
  live: boolean;
}>();

const { t } = useI18n();
const monitor = useMonitorStore();

const sample = computed(() => (props.live ? monitor.sample : null));
const memory = computed(() => sample.value?.memory ?? null);

/**
 * Whether this page has drawn a reading in its life.
 *
 * The skeleton is a first-read body: it promises the shape of what is coming, and that promise is
 * only good before anything has arrived. After one reading has been drawn the page never goes
 * back to pretending — a later silence is the empty state's to explain.
 */
const hasDrawn = ref(false);
watch(
  () => props.live,
  (live) => {
    if (live) {
      hasDrawn.value = true;
    }
  },
  { immediate: true },
);

/** Waiting for the first answer, with nothing failed yet: the skeleton's moment. */
const showSkeleton = computed(() => !props.live && !hasDrawn.value && monitor.failure === null);
/** No reading and none arriving on its own: the empty state with its way out. */
const showUnanswered = computed(() => !props.live && (hasDrawn.value || monitor.failure !== null));

const upFor = computed(() => {
  const seconds = sample.value?.uptimeSeconds;
  if (seconds === null || seconds === undefined) {
    return UNKNOWN;
  }
  const { days, hours, minutes } = uptime(seconds);
  const rest = { hours, minutes: String(minutes).padStart(2, "0") };
  return days > 0 ? t("monitor.uptime.days", { ...rest, days }) : t("monitor.uptime.hours", rest);
});

/** How full the memory runs, which is what the band's tile and the chart both say. */
const memoryLevel = computed(() => {
  const usage = memory.value;
  return usage ? share(memoryUsed(usage), usage.totalBytes) : null;
});

const memoryRows = computed(() => {
  const usage = memory.value;
  const used = usage ? memoryUsed(usage) : null;
  return {
    total: usage ? formatSize(usage.totalBytes) : UNKNOWN,
    used: usage ? formatSize(used ?? 0) : UNKNOWN,
    percent: usage ? percentOf(share(used ?? 0, usage.totalBytes)) : UNKNOWN,
    available: usage ? formatSize(usage.availableBytes) : UNKNOWN,
  };
});

const swapRows = computed(() => {
  const usage = memory.value;
  const used = usage ? swapUsed(usage) : null;
  return {
    total: usage ? formatSize(usage.swapTotalBytes) : UNKNOWN,
    used: usage ? formatSize(used ?? 0) : UNKNOWN,
    percent: usage ? percentOf(share(used ?? 0, usage.swapTotalBytes)) : UNKNOWN,
    available: usage ? formatSize(usage.swapFreeBytes) : UNKNOWN,
  };
});

/**
 * The swap ring, when there is a swap to be full: a host without one draws no ring at all, and
 * its empty state is the sentence below the readings rather than a gauge at zero.
 */
const swapGauge = computed(() => {
  const usage = memory.value;
  if (!usage || usage.swapTotalBytes <= 0) {
    return null;
  }
  return share(swapUsed(usage), usage.swapTotalBytes);
});

const noSwap = computed(() => memory.value !== null && memory.value.swapTotalBytes === 0);

const cpuReading = computed(() => percentOf(monitor.cpuPercent, 1));
const memoryReading = computed(() => percentOf(memoryLevel.value, 1));
const swapReading = computed(() => percentOf(swapGauge.value, 1));
const loadReading = computed(() => (sample.value?.load ? sample.value.load.one.toFixed(2) : UNKNOWN));

/** The tiers the usage readings wear, at the one pair of cuts every gauge answers to. */
const cpuTone = computed(() => (monitor.cpuPercent === null ? undefined : usageTone(monitor.cpuPercent)));
const memoryTone = computed(() => (memoryLevel.value === null ? undefined : usageTone(memoryLevel.value)));
const swapTone = computed(() => (swapGauge.value === null ? undefined : usageTone(swapGauge.value)));

/** The memory chart wears the tier of the reading it has just drawn, the overview's rule. */
const memoryAreaTone = computed<"ok" | "warn" | "danger">(() => {
  const latest = monitor.memoryHistory[monitor.memoryHistory.length - 1];
  return latest === undefined ? "ok" : usageTone(latest);
});

/** The share each CPU column was of the last interval, in the order the page lists them. */
const cpuShares = computed(() =>
  (monitor.cpuShares ?? []).map((share) => ({ state: share.state, labelKey: CPU_STATE_LABELS[share.state], share })),
);

/** Used space and how much of the file system it is, which is the column people read. */
const diskRows = computed(() =>
  (sample.value?.disks ?? []).map((disk: DiskUsage) => {
    const used = Math.max(0, disk.sizeBytes - disk.availableBytes);
    return { disk, used: formatSize(used), percent: share(used, disk.sizeBytes) };
  }),
);
</script>

<template>
  <!--
    The first read: the shape of what is coming, before the host has said anything. The skeleton
    mirrors the band, the two charts and the share bars — the first screen only, since the sections
    below it are the same page either way.
  -->
  <div v-if="showSkeleton" class="min-h-0 flex-1 space-y-5 overflow-hidden" data-report-skeleton aria-hidden="true">
    <div class="space-y-2">
      <div class="skeleton h-4 w-44"></div>
      <div class="grid grid-cols-2 gap-2 md:grid-cols-5">
        <div v-for="tile in 5" :key="tile" class="skeleton h-16"></div>
      </div>
    </div>
    <div class="grid gap-5 md:grid-cols-2">
      <div v-for="chart in 2" :key="chart" class="skeleton h-32"></div>
    </div>
    <div class="space-y-2">
      <div class="skeleton h-3 w-28"></div>
      <div v-for="bar in 4" :key="bar" class="skeleton h-2.5 w-full"></div>
    </div>
  </div>

  <!-- No reading and none arriving: one sentence, and the retry that asks the host again now. -->
  <div v-else-if="showUnanswered" class="state-empty min-h-0 flex-1" data-report-unanswered>
    <p>{{ t("inspect.report.unanswered") }}</p>
    <button
      type="button"
      data-report-retry
      class="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-accent"
      @click="monitor.retry()"
    >
      <RotateCw :size="12" aria-hidden="true" />
      {{ t("common.action.retry") }}
    </button>
  </div>

  <div v-else class="min-h-0 flex-1 space-y-5 overflow-auto">
    <!--
      The band: the host's name and the readings a first screen anchors on, with the usage tiers
      painted where a reading is one — a load average and an uptime are not usages, and wear none.
    -->
    <section data-report-band>
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h3 class="min-w-0 truncate font-mono text-sm font-semibold">{{ orUnknown(sample?.hostname) }}</h3>
        <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ orUnknown(sample?.os) }}</span>
      </div>
      <div class="mt-2 grid grid-cols-2 gap-2 md:grid-cols-5">
        <StatTile
          data-report-tile-cpu
          :label="t('monitor.cpu')"
          :value="cpuReading"
          :tone="cpuTone"
          :series="monitor.cpuHistory"
        />
        <StatTile
          data-report-tile-memory
          :label="t('monitor.memory')"
          :value="memoryReading"
          :tone="memoryTone"
          :series="monitor.memoryHistory"
        />
        <StatTile data-report-tile-swap :label="t('monitor.swap')" :value="swapReading" :tone="swapTone" />
        <StatTile
          data-report-tile-load
          :label="t('monitor.load')"
          :value="loadReading"
          :title="t('monitor.loadHint')"
        />
        <StatTile data-report-tile-uptime :label="t('monitor.uptime.label')" :value="upFor" />
      </div>
    </section>

    <!--
      The two trends, drawn from the store's own buffers: bands of samples, not a line claiming the
      space between them was measured. The memory chart wears the tier its latest reading earns;
      the processor chart keeps the series colour, the way the container overview draws the pair.
    -->
    <section class="grid gap-5 md:grid-cols-2" data-report-charts>
      <SparkArea
        class="[&>svg]:h-auto [&>svg]:w-full"
        data-report-chart-cpu
        :label="t('inspect.report.cpuTrend')"
        :values="monitor.cpuHistory"
        tone="accent"
        :value="cpuReading"
      />
      <SparkArea
        class="[&>svg]:h-auto [&>svg]:w-full"
        data-report-chart-memory
        :label="t('inspect.report.memoryTrend')"
        :values="monitor.memoryHistory"
        :tone="memoryAreaTone"
        :value="memoryReading"
      />
    </section>

    <!--
      Where the processors' time went, one bar a column: the htop answer, with the number the bar
      is of beside it. These are shares of an interval, not usages of a capacity — no tier here,
      only the series colour a column of bars can share.
    -->
    <section data-report-share>
      <h3 class="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {{ t("inspect.cpu.share") }}
      </h3>
      <p class="mb-2 cursor-default select-none text-[11px] text-muted-foreground">{{ t("inspect.cpu.shareHint") }}</p>
      <ul v-if="cpuShares.length > 0" class="space-y-1.5">
        <li v-for="entry in cpuShares" :key="entry.share.state" class="flex items-center gap-2 text-xs">
          <span class="w-24 shrink-0 truncate text-muted-foreground">{{ t(entry.labelKey) }}</span>
          <span class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-sm bg-muted">
            <span
              class="block h-full rounded-sm"
              :style="{ width: `${entry.share.percent}%`, background: TONE_TOKENS.accent }"
            ></span>
          </span>
          <span class="nums w-14 shrink-0 text-right">{{ percentOf(entry.share.percent, 1) }}</span>
        </li>
      </ul>
      <p v-else class="text-xs text-muted-foreground">{{ UNKNOWN }}</p>
    </section>

    <!-- The static detail: what this machine is, asked once, kept below the first screen. -->
    <section data-report-details>
      <h3 class="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {{ t("inspect.system.details") }}
      </h3>
      <dl class="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1 text-xs">
        <dt class="text-muted-foreground">{{ t("monitor.system.kernel") }}</dt>
        <dd class="font-mono">{{ orUnknown(sample?.kernel) }}</dd>

        <dt class="text-muted-foreground">{{ t("inspect.system.arch") }}</dt>
        <dd class="font-mono">{{ orUnknown(sample?.arch) }}</dd>
      </dl>
      <table class="mt-3" :class="TABLE.page.table" :aria-label="t('monitor.cpu')">
        <thead :class="TABLE.page.head">
          <tr :class="TABLE.page.headRow">
            <th class="text-left" :class="TABLE.page.headCell">{{ t("inspect.cpu.name") }}</th>
            <th class="w-20 text-right" :class="TABLE.page.headCell">{{ t("inspect.cpu.cores") }}</th>
            <th class="w-28 text-right" :class="TABLE.page.headCell">{{ t("inspect.cpu.frequency") }}</th>
            <th class="w-24 text-right" :class="TABLE.page.headCell">{{ t("inspect.cpu.cache") }}</th>
            <th class="w-24 text-right" :class="TABLE.page.headCell">{{ t("inspect.cpu.bogomips") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr :class="rowClass('page')">
            <td :class="TABLE.page.cell">{{ orUnknown(sample?.cpuModel?.name) }}</td>
            <td class="text-right" :class="TABLE.page.cell">
              <span class="nums">{{ orUnknown(sample?.cores) }}</span>
            </td>
            <td class="text-right" :class="TABLE.page.cell">
              <span class="nums">
                {{
                  sample?.cpuModel?.frequencyMhz === null || sample?.cpuModel?.frequencyMhz === undefined
                    ? UNKNOWN
                    : t("inspect.cpu.megahertz", { value: sample.cpuModel.frequencyMhz.toFixed(3) })
                }}
              </span>
            </td>
            <td class="text-right" :class="TABLE.page.cell">
              <span class="nums">
                {{
                  sample?.cpuModel?.cacheKb === null || sample?.cpuModel?.cacheKb === undefined
                    ? UNKNOWN
                    : t("inspect.cpu.kilobytes", { value: sample.cpuModel.cacheKb })
                }}
              </span>
            </td>
            <td class="text-right" :class="TABLE.page.cell">
              <span class="nums">{{ orUnknown(sample?.cpuModel?.bogomips) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- The readings behind the band's two tiles, and the swap gauge once a swap exists. -->
    <section class="grid gap-5 md:grid-cols-2" data-report-memory>
      <div>
        <h3 class="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {{ t("monitor.memory") }}
        </h3>
        <dl class="grid grid-cols-[4rem_1fr] gap-x-4 gap-y-1 text-xs">
          <dt class="text-muted-foreground">{{ t("inspect.memory.total") }}</dt>
          <dd class="nums">{{ memoryRows.total }}</dd>
          <dt class="text-muted-foreground">{{ t("inspect.memory.used") }}</dt>
          <dd class="nums">{{ memoryRows.used }}</dd>
          <dt class="text-muted-foreground">{{ t("inspect.memory.percent") }}</dt>
          <dd class="nums">{{ memoryRows.percent }}</dd>
          <dt class="text-muted-foreground">{{ t("inspect.memory.available") }}</dt>
          <dd class="nums">{{ memoryRows.available }}</dd>
        </dl>
      </div>

      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <h3 class="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {{ t("monitor.swap") }}
          </h3>
          <dl class="grid grid-cols-[4rem_1fr] gap-x-4 gap-y-1 text-xs">
            <dt class="text-muted-foreground">{{ t("inspect.memory.total") }}</dt>
            <dd class="nums">{{ swapRows.total }}</dd>
            <dt class="text-muted-foreground">{{ t("inspect.memory.used") }}</dt>
            <dd class="nums">{{ swapRows.used }}</dd>
            <dt class="text-muted-foreground">{{ t("inspect.memory.percent") }}</dt>
            <dd class="nums">{{ swapRows.percent }}</dd>
            <dt class="text-muted-foreground">{{ t("inspect.memory.available") }}</dt>
            <dd class="nums">{{ swapRows.available }}</dd>
          </dl>
          <p v-if="noSwap" class="mt-1.5 text-[11px] text-muted-foreground">{{ t("inspect.swap.none") }}</p>
        </div>
        <RingGauge v-if="swapGauge !== null" class="shrink-0" :percent="swapGauge" :label="t('monitor.swap')" />
      </div>
    </section>

    <section>
      <h3 class="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {{ t("monitor.disks.title") }}
      </h3>
      <table :class="TABLE.page.table" :aria-label="t('monitor.disks.title')">
        <thead :class="TABLE.page.head">
          <tr :class="TABLE.page.headRow">
            <th class="text-left" :class="TABLE.page.headCell">{{ t("inspect.disk.name") }}</th>
            <th class="text-right" :class="TABLE.page.headCell">{{ t("inspect.disk.size") }}</th>
            <th class="text-right" :class="TABLE.page.headCell">{{ t("inspect.disk.used") }}</th>
            <th class="w-40 text-right" :class="TABLE.page.headCell">{{ t("inspect.disk.percent") }}</th>
            <th class="text-right" :class="TABLE.page.headCell">{{ t("inspect.disk.available") }}</th>
            <th class="text-right" :class="TABLE.page.headCell">{{ t("inspect.disk.mount") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in diskRows" :key="`${row.disk.filesystem}:${row.disk.mountPoint}`" :class="rowClass('page')">
            <td class="max-w-0 truncate font-mono" :class="TABLE.page.cell" :title="row.disk.filesystem">
              {{ row.disk.filesystem }}
            </td>
            <td class="text-right" :class="TABLE.page.cell">
              <span class="nums">{{ formatSize(row.disk.sizeBytes) }}</span>
            </td>
            <td class="text-right" :class="TABLE.page.cell">
              <span class="nums">{{ row.used }}</span>
            </td>
            <td class="text-right" :class="TABLE.page.cell">
              <span class="flex items-center justify-end gap-2">
                <span class="w-20 shrink-0">
                  <MiniBar :percent="row.percent" :label="t('inspect.disk.percent')" />
                </span>
                <span class="nums w-12 shrink-0 text-right">{{ percentOf(row.percent) }}</span>
              </span>
            </td>
            <td class="text-right" :class="TABLE.page.cell">
              <span class="nums">{{ formatSize(row.disk.availableBytes) }}</span>
            </td>
            <td class="font-mono" :class="TABLE.page.cell">{{ row.disk.mountPoint }}</td>
          </tr>
          <tr v-if="props.live && diskRows.length === 0">
            <td colspan="6" :class="TABLE.page.emptyCell">{{ t("monitor.disks.empty") }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section>
      <h3 class="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {{ t("inspect.network.group") }}
      </h3>
      <InterfaceTable :live="props.live" />
    </section>
  </div>
</template>
