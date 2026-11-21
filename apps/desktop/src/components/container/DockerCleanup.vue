<script setup lang="ts">
/**
 * The Docker window's cleanup page: the engine's disk reading first, and the prunes beside the
 * numbers they would change.
 *
 * The order is the page's whole point: `system df` is read before anything is offered, so the
 * confirm quotes a number the engine itself gave, and the same read answers again after a run —
 * the two readings are the receipt. Each tier is its own engine verb with its own checkbox, and
 * the volumes tier starts unchecked and keeps a warning of its own, because no other verb in this
 * window takes that much data with one click: a volume prune deletes every volume nothing is
 * mounted from, and the checkbox may not be sent until the person has agreed to exactly that.
 *
 * The list is read when the page opens and when the refresh is pressed, and after a run — and at
 * no other time: nothing here refreshes itself, because a reading is about to be quoted in a
 * question and a stale one would quote badly.
 */
import { LoaderCircle, RotateCw, TriangleAlert, X } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import MiniBar from "@/components/charts/MiniBar.vue";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import WbButton from "@/components/ui/WbButton.vue";
import WbEmpty from "@/components/ui/WbEmpty.vue";
import { describeShellError } from "@/i18n/errors";
import { backend } from "@/lib/backend/api";
import { asShellError, type ShellError } from "@/lib/backend/errors";
import { TABLE, rowClass } from "@/lib/table";
import { cn } from "@/lib/utils";
import type { ContainerSession } from "@/stores/container";
import type { ContainerDiskUsage, ContainerDiskUsageKind, ContainerPruneReport } from "@/types/container";

import { formatBytes, reclaimablePercent, reclaimableTotal } from "./cleanup";

const props = defineProps<{ session: ContainerSession }>();

const { t } = useI18n();

// -- the reading ------------------------------------------------------------------

const usage = ref<ContainerDiskUsage[]>([]);
const loading = ref(false);
const failure = ref<ShellError | null>(null);

const KIND_KEYS: Readonly<Record<ContainerDiskUsageKind, string>> = {
  images: "container.desktop.cleanup.kind.images",
  containers: "container.desktop.cleanup.kind.containers",
  volumes: "container.desktop.cleanup.kind.volumes",
  buildCache: "container.desktop.cleanup.kind.buildCache",
};

/** The tiers' verbs and their sentences, keyed literally so a missing translation is a missing
 * entry the i18n check can name, not a raw key in the window. */
const TIER_KEYS: Readonly<Record<ContainerDiskUsageKind, string>> = {
  images: "container.desktop.cleanup.tier.images",
  containers: "container.desktop.cleanup.tier.containers",
  volumes: "container.desktop.cleanup.tier.volumes",
  buildCache: "container.desktop.cleanup.tier.buildCache",
};

const TIER_HINT_KEYS: Readonly<Record<ContainerDiskUsageKind, string>> = {
  images: "container.desktop.cleanup.tierHint.images",
  containers: "container.desktop.cleanup.tierHint.containers",
  volumes: "container.desktop.cleanup.tierHint.volumes",
  buildCache: "container.desktop.cleanup.tierHint.buildCache",
};

function kindLabel(kind: ContainerDiskUsageKind): string {
  return t(KIND_KEYS[kind]);
}

/**
 * Reads the engine's numbers once. Called when the page mounts, when the refresh is pressed, and
 * again after a run — where the fresh reading is the receipt for what the prunes took.
 */
async function load(): Promise<void> {
  const connectionId = props.session.connectionId;
  if (connectionId === null || loading.value) {
    return;
  }
  loading.value = true;
  try {
    const answer = await backend.dockerCleanup.df(connectionId);
    if (props.session.connectionId === connectionId) {
      usage.value = answer;
      failure.value = null;
    }
  } catch (error) {
    if (props.session.connectionId === connectionId) {
      failure.value = asShellError(error, "system_df");
    }
  } finally {
    if (props.session.connectionId === connectionId) {
      loading.value = false;
    }
  }
}

onMounted(() => {
  void load();
});

// -- the tiers --------------------------------------------------------------------

type TierKind = ContainerDiskUsageKind;

/** Whether each tier is in for the next run. The volumes tier starts out, and stays out until a
 * person picks it up: the warning beside it explains why the default is no. */
const tiers = ref<Record<TierKind, boolean>>({
  containers: true,
  images: true,
  buildCache: true,
  volumes: false,
});

/** The kinds in the order a run walks them — the order the engine reads, cheapest first. */
const TIER_ORDER: readonly TierKind[] = ["containers", "images", "buildCache", "volumes"];

function usageOf(kind: TierKind): ContainerDiskUsage | undefined {
  return usage.value.find((row) => row.kind === kind);
}

/** What one tier's line in the confirm says: the verb, and the number the engine gave for it. */
function tierDetail(kind: TierKind): string {
  const reading = usageOf(kind);
  const reclaimable = reading ? formatBytes(reading.reclaimable) : t("container.desktop.cleanup.unknown");
  return `${t(TIER_KEYS[kind])} — ${t("container.desktop.cleanup.reclaimableShort", { size: reclaimable })}`;
}

const checkedTiers = computed(() => TIER_ORDER.filter((kind) => tiers.value[kind]));
const anyChecked = computed(() => checkedTiers.value.length > 0);
const expectedTotal = computed(() =>
  reclaimableTotal(checkedTiers.value.map((kind) => usageOf(kind) ?? { reclaimable: 0 })),
);

// -- the run ----------------------------------------------------------------------

interface TierOutcome {
  kind: TierKind;
  /** What the engine answered, when the tier ran; null for the image tier, whose verb is the
   * images page's own and carries no report. */
  report: ContainerPruneReport | null;
  error: ShellError | null;
}

const confirmOpen = ref(false);
const running = ref(false);
const lastRun = ref<TierOutcome[] | null>(null);
const runFailure = ref<ShellError | null>(null);

function openConfirm(): void {
  if (!anyChecked.value || running.value) {
    return;
  }
  confirmOpen.value = true;
}

/** One prune per checked tier, in the page's order, each reported on its own: a tier the engine
 * refused does not stop the others, and the report says which went and which did not. */
async function runPrunes(): Promise<void> {
  const connectionId = props.session.connectionId;
  confirmOpen.value = false;
  if (connectionId === null) {
    return;
  }
  running.value = true;
  runFailure.value = null;
  const outcomes: TierOutcome[] = [];
  try {
    for (const kind of checkedTiers.value) {
      try {
        let report: ContainerPruneReport | null = null;
        if (kind === "images") {
          // The image tier is the images page's own prune — the verb the image list has run since
          // before this page existed — and it answers nothing beyond done. The receipt is the
          // fresh reading, which the finally below takes either way.
          await backend.containers.imagePrune(connectionId, true);
        } else {
          report = await runPrune(connectionId, kind);
        }
        outcomes.push({ kind, report, error: null });
      } catch (error) {
        outcomes.push({ kind, report: null, error: asShellError(error, "container_image_prune") });
      }
    }
    lastRun.value = outcomes;
  } finally {
    running.value = false;
    // The fresh reading is the receipt: whatever the run took is gone from the numbers.
    await load();
  }
}

async function runPrune(connectionId: string, kind: TierKind): Promise<ContainerPruneReport> {
  switch (kind) {
    case "containers":
      return backend.dockerCleanup.pruneContainers(connectionId, true);
    case "volumes":
      return backend.dockerCleanup.pruneVolumes(connectionId, true);
    case "buildCache":
      return backend.dockerCleanup.pruneBuildCache(connectionId, true);
    case "images":
      throw new Error("the image tier runs through the images page's own verb");
  }
}

function describe(error: ShellError): string {
  return describeShellError((key, params) => (params ? t(key, params) : t(key)), error).message;
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The page head: the page's name bold and the refresh at the far end, the way the other
         pages of this window draw theirs. -->
    <div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <h2 class="shrink-0 text-lg font-bold leading-none">{{ t("container.rail.cleanup") }}</h2>
      <div class="min-w-0 flex-1"></div>
      <WbButton variant="primary" data-cleanup-run :disabled="!anyChecked || running" @click="openConfirm()">
        {{ running ? t("container.desktop.cleanup.running") : t("container.desktop.cleanup.run") }}
      </WbButton>
      <button
        type="button"
        class="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--workbench-on-picture)_6%,transparent)] hover:text-foreground"
        :title="t('container.refresh')"
        :aria-label="t('container.refresh')"
        data-cleanup-refresh
        @click="load()"
      >
        <RotateCw :size="12" />
      </button>
    </div>

    <!-- The page's own failures: the catalog's sentence for whatever the engine refused. -->
    <div
      v-if="failure"
      role="alert"
      class="flex shrink-0 items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 select-text"
      data-cleanup-failure
    >
      <span class="min-w-0 flex-1 text-[11px]">{{ describe(failure) }}</span>
      <button
        type="button"
        class="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        :title="t('container.dismiss')"
        :aria-label="t('container.dismiss')"
        @click="failure = null"
      >
        <X :size="11" />
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto px-3 pb-3">
      <!-- The reading first: the four rows the engine counts, each with what it occupies and what
           the engine says it could give back. The bar is the reclaimable share, in the desktops'
           own tone. -->
      <p
        v-if="loading && usage.length === 0"
        class="flex items-center gap-1.5 px-1 py-3 text-[11px] text-muted-foreground"
        data-cleanup-loading
      >
        <LoaderCircle :size="12" class="animate-spin" />
        {{ t("container.desktop.cleanup.loading") }}
      </p>
      <table
        v-else
        :class="TABLE.page.table"
        :style="{ minWidth: '620px' }"
        :aria-label="t('container.rail.cleanup')"
        data-cleanup-usage
      >
        <thead :class="TABLE.page.head">
          <tr :class="TABLE.page.headRow">
            <th class="w-[24%]" :class="TABLE.page.headCell">{{ t("container.desktop.cleanup.kindColumn") }}</th>
            <th class="w-[14%]" :class="TABLE.page.headCell">{{ t("container.desktop.cleanup.count") }}</th>
            <th class="w-[20%]" :class="TABLE.page.headCell">{{ t("container.desktop.cleanup.size") }}</th>
            <th class="w-[26%]" :class="TABLE.page.headCell">{{ t("container.desktop.cleanup.reclaimable") }}</th>
            <th class="w-[16%]" :class="TABLE.page.headCell">{{ t("container.desktop.cleanup.share") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in usage" :key="row.kind" :class="cn(rowClass('page', { striped: true }))">
            <td :class="TABLE.page.cell">{{ kindLabel(row.kind) }}</td>
            <td :class="TABLE.page.cell">
              <span class="nums text-[11px]" data-cleanup-count>{{ row.count }}</span>
            </td>
            <td :class="TABLE.page.cell">
              <span class="nums text-[11px]" data-cleanup-size>{{ formatBytes(row.size) }}</span>
            </td>
            <td :class="TABLE.page.cell">
              <span class="nums text-[11px]" data-cleanup-reclaimable>{{ formatBytes(row.reclaimable) }}</span>
            </td>
            <td :class="TABLE.page.cell">
              <MiniBar
                :percent="reclaimablePercent(row)"
                :label="t('container.desktop.cleanup.shareLabel', { kind: kindLabel(row.kind) })"
              />
            </td>
          </tr>
          <tr v-if="usage.length === 0">
            <td :colspan="5" :class="cn(TABLE.page.cell, TABLE.page.emptyCell)">
              <WbEmpty scenario="noData" size="sm" :description="t('container.desktop.cleanup.none')" class="mx-auto" />
            </td>
          </tr>
        </tbody>
      </table>

      <!-- What the last run took, while the fresh reading above is the receipt. -->
      <div v-if="lastRun" class="mt-3 rounded-md border border-border bg-background px-3 py-2" data-cleanup-report>
        <p class="text-[11px] font-medium">{{ t("container.desktop.cleanup.lastRun") }}</p>
        <p v-for="outcome in lastRun" :key="outcome.kind" class="mt-1 flex items-center gap-1.5 text-[11px]">
          <TriangleAlert v-if="outcome.error" :size="11" class="shrink-0 text-destructive" />
          <span v-if="outcome.error" class="text-destructive">
            {{ t("container.desktop.cleanup.tierFailed", { tier: kindLabel(outcome.kind) }) }}
            {{ describe(outcome.error) }}
            <span v-if="outcome.error.detail" class="block text-[10px] text-muted-foreground select-text">
              {{ outcome.error.detail }}
            </span>
          </span>
          <span v-else-if="outcome.report" class="text-muted-foreground">
            {{
              t("container.desktop.cleanup.tierDone", {
                tier: kindLabel(outcome.kind),
                size: formatBytes(outcome.report.reclaimed),
              })
            }}
            <span v-if="outcome.report.deleted?.length" class="nums text-muted-foreground">
              {{ t("container.desktop.cleanup.deletedCount", { count: outcome.report.deleted.length }) }}
            </span>
          </span>
          <span v-else class="text-muted-foreground">
            {{ t("container.desktop.cleanup.tierDonePlain", { tier: kindLabel(outcome.kind) }) }}
          </span>
        </p>
      </div>

      <!-- The tiers: each its own checkbox and its own sentence. The volumes one carries the
           warning, unchecked by default, and the confirm repeats its consequence before it runs. -->
      <div class="mt-3 rounded-md border border-border bg-background px-3 py-2">
        <p class="text-[11px] font-medium">{{ t("container.desktop.cleanup.tiersTitle") }}</p>
        <label
          v-for="kind in TIER_ORDER"
          :key="kind"
          class="mt-2 flex items-start gap-2 text-[11px]"
          :data-cleanup-tier="kind"
        >
          <input v-model="tiers[kind]" type="checkbox" class="mt-0.5" :data-cleanup-tier-check="kind" />
          <span class="min-w-0 flex-1">
            <span class="block">{{ t(TIER_KEYS[kind]) }}</span>
            <span class="block text-[10px] text-muted-foreground">
              {{ t(TIER_HINT_KEYS[kind]) }}
            </span>
            <span v-if="kind === 'volumes'" class="mt-0.5 flex items-start gap-1 text-[10px] text-warning">
              <TriangleAlert :size="11" class="mt-0.5 shrink-0" />
              {{ t("container.desktop.cleanup.volumeWarning") }}
            </span>
          </span>
        </label>
        <p v-if="anyChecked" class="nums mt-2 text-[11px] text-muted-foreground">
          {{ t("container.desktop.cleanup.expected", { size: formatBytes(expectedTotal) }) }}
        </p>
      </div>
    </div>

    <!--
      The run's own gate: the checked tiers, each named with the number the engine gave, the volumes
      consequence said again in full. The acknowledged flags the verbs demand are this confirm's
      answer — the volume one only ever leaves this dialog.
    -->
    <ConfirmDialog
      :open="confirmOpen"
      :title="t('container.desktop.cleanup.confirmTitle')"
      :message="t('container.desktop.cleanup.confirmMessage')"
      :details="checkedTiers.map(tierDetail)"
      :confirm-label="t('container.desktop.cleanup.run')"
      :loading="running"
      danger
      @confirm="runPrunes()"
      @update:open="confirmOpen = $event"
    />
  </div>
</template>
