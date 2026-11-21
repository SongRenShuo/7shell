<script setup lang="ts">
/**
 * The container workspace: one engine, seen three ways.
 *
 * All three views stay mounted and are hidden with `v-show`, for the same reason the pane itself is
 * kept mounted across tabs: a log stream, a pull in progress or half-typed filter must survive a look
 * at another view. Unmounting on a switch would stop the stream, and the line somebody was waiting
 * for would have gone by unseen.
 *
 * The connection is opened here once, on mount, and closed by `terminals` when the tab goes away. On
 * unmount this pane only forgets its share of the state — see `useContainerStore.forget`.
 *
 * Two layouts share this pane, and the prop picks between them. `flat` — the default — is the
 * application tab's workspace exactly as it has always been drawn. `desktop` is the desktop
 * window's: the 220px side rail the reference Docker manager keeps, the overview with the engine's
 * vital signs, and the pages rebuilt for a window rather than a strip. The connection, the store
 * and the view keeping are the same in both — only the drawing differs, so the application tab
 * never sees the desktop's presentational choices.
 */
import { Blocks, Boxes, Eraser, Gauge, HardDrive, Layers, LoaderCircle, RotateCw, Waypoints, X } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import DockerCleanup from "@/components/container/DockerCleanup.vue";
import DockerImages from "@/components/container/DockerImages.vue";
import DockerNetworks from "@/components/container/DockerNetworks.vue";
import DockerOverview from "@/components/container/DockerOverview.vue";
import DockerVolumes from "@/components/container/DockerVolumes.vue";
import DockerCompose from "@/components/container/DockerCompose.vue";
import ContainerUpgradeDialog from "@/components/container/ContainerUpgradeDialog.vue";
import WbSideNav, { type SideNavItem } from "@/components/container/WbSideNav.vue";
import Select, { type SelectOption } from "@/components/ui/Select.vue";
import WbButton from "@/components/ui/WbButton.vue";
import { describeShellError } from "@/i18n/errors";
import { useToast } from "@/composables/useToast";
import { backend } from "@/lib/backend/api";
import { asShellError } from "@/lib/backend/errors";
import { cn } from "@/lib/utils";
import { supportsNamespace, useContainerStore } from "@/stores/container";
import type { ContainerTab } from "@/stores/terminals";
import type { ContainerDetail, ContainerSummary } from "@/types/container";

import ContainerImageView from "./ContainerImageView.vue";
import ContainerListView from "./ContainerListView.vue";
import ContainerMonitorDialog from "./ContainerMonitorDialog.vue";
import ContainerOverview from "./ContainerOverview.vue";
import ContainerWizard, { type ContainerClonePrefill } from "./ContainerWizard.vue";

const props = withDefaults(
  defineProps<{
    tab: ContainerTab;
    active: boolean;
    /** `flat` is the application tab's workspace; `desktop` is the desktop window's. */
    layout?: "desktop" | "flat";
  }>(),
  { layout: "flat" },
);

type ContainerView = "overview" | "containers" | "images" | "volumes" | "cleanup" | "networks" | "compose";

const { t } = useI18n();
const containers = useContainerStore();

const desktop = computed(() => props.layout === "desktop");

const view = ref<ContainerView>("overview");
/** Set when the images view asked to see which containers run an image. */
const imageFilter = ref<string | null>(null);
/** Set when the overview's state counts were clicked. */
const stateFilter = ref<string | null>(null);
/** Whether the desktop's create wizard is open; the flat workspace has no wizard to open. */
const wizardOpen = ref(false);
/** The container the upgrade dialog is working on, and whether the dialog is showing. */
const upgradeTarget = ref<ContainerSummary | null>(null);
const upgradeOpen = ref(false);

const session = computed(() => containers.sessionFor(props.tab.id));
const runtime = computed(() => props.tab.session.container?.runtime ?? "docker");
const problem = computed(() => (session.value?.error ? describeShellError(translate, session.value.error) : null));
/**
 * The engine's own reason, drawn under the summary sentence: the summary names the operation the
 * runtime refused, the detail is what the engine actually said — "no such container", a template
 * error, a channel that ended without a status. The fallback rendering (a key with no translation)
 * puts the detail in the message already, and the same sentence twice says nothing new.
 */
const problemDetail = computed(() => {
  const detail = problem.value?.detail;
  return detail && detail !== problem.value?.message ? detail : null;
});

const rail = computed(() => [
  {
    view: "overview" as const,
    labelKey: "container.rail.overview",
    icon: Gauge,
    count: null as number | null,
  },
  {
    view: "containers" as const,
    labelKey: "container.rail.containers",
    icon: Boxes,
    count: session.value?.containers.length ?? null,
  },
  {
    view: "images" as const,
    labelKey: "container.rail.images",
    icon: Layers,
    count: session.value?.images.length ?? null,
  },
]);

/** The namespace picker's choices: what the runtime listed, plus the default and the chosen one. */
const namespaceOptions = computed(() => {
  const current = session.value;
  if (!current) {
    return [];
  }
  const names = new Set(current.namespaces);
  names.add(current.namespace);
  names.add("default");
  return [...names].sort().map((name) => ({ value: name, label: name }));
});

/**
 * The desktop rail's rows, and the rules it carries: an engine this session has not reached — not
 * connected yet, or failed to — offers the overview and nothing else; and a capability the engine
 * says it does not have (a host without the Compose plugin, an engine that did not answer the
 * network probe) trims its page from the rail, the way the reference manager trims its own. A bit
 * that has not been probed yet is read as "has it" — a page the engine may yet answer for is
 * drawn, and taken away if the answer is no.
 */
const sideRail = computed<readonly SideNavItem[]>(() => {
  const current = session.value;
  const connected = current !== undefined && current.connectionId !== null;
  const overview: SideNavItem = { id: "overview", label: t("container.rail.overview"), icon: Gauge, count: null };
  if (!connected) {
    return [overview];
  }
  const items: SideNavItem[] = [
    overview,
    { id: "containers", label: t("container.rail.containers"), icon: Boxes, count: current.containers.length },
    { id: "images", label: t("container.rail.images"), icon: Layers, count: current.images.length },
  ];
  if (current.info?.volumeAvailable !== false) {
    items.push({ id: "volumes", label: t("container.rail.volumes"), icon: HardDrive, count: null });
  }
  items.push({ id: "cleanup", label: t("container.rail.cleanup"), icon: Eraser, count: null });
  if (current.info?.networkAvailable !== false) {
    items.push({ id: "networks", label: t("container.rail.networks"), icon: Waypoints, count: null });
  }
  if (current.info?.composeAvailable !== false) {
    items.push({ id: "compose", label: t("container.rail.compose"), icon: Blocks, count: null });
  }
  return items;
});

// A page trimmed from the rail while it was on screen is not a page to stay on: the rail decides
// what may be open, so the view goes back to the overview the rail always keeps.
watch(sideRail, (items) => {
  if (!items.some((item) => item.id === view.value)) {
    view.value = "overview";
  }
});

function translate(key: string, params?: Record<string, string>): string {
  return params ? t(key, params) : t(key);
}

function dismiss(): void {
  containers.dismissError(props.tab.id);
}

function retry(): void {
  void containers.connect(props.tab);
}

function showState(state: string): void {
  imageFilter.value = null;
  // The total is the absence of a state filter, not a state called "": the list reads `null` as
  // "any state" and an empty string as a state nothing matches.
  stateFilter.value = state === "" ? null : state;
  view.value = "containers";
}

function showRelatedContainers(reference: string): void {
  stateFilter.value = null;
  imageFilter.value = reference;
  view.value = "containers";
}

function chooseNamespace(namespace: string): void {
  if (namespace === session.value?.namespace) {
    return;
  }
  void containers.setNamespace(props.tab.id, namespace);
}

/**
 * The networks the wizard offers its networks field, read from the engine once each time the
 * wizard opens — a list read when the dialog asks is current; a list cached from the pane's
 * first minute is not. Where the engine does not answer (a host without the listing, a read
 * that failed) the field falls back to names typed by hand, which is the wizard's own degrade.
 */
const wizardNetworks = ref<readonly SelectOption[]>([]);

/** What a clone ask pre-fills the wizard with, or null for a plain create. */
const wizardPrefill = ref<ContainerClonePrefill | null>(null);

/** The container whose charts are open, and whether that dialog is showing. */
const monitorTarget = ref<ContainerSummary | null>(null);
const monitorOpen = ref(false);

function openMonitor(container: ContainerSummary): void {
  monitorTarget.value = container;
  monitorOpen.value = true;
}

/**
 * Answers the list's upgrade ask: the dialog is where the registry is asked whether the tag moved
 * and where the transaction's confirm lives — the row only offers it.
 */
function openUpgrade(container: ContainerSummary): void {
  upgradeTarget.value = container;
  upgradeOpen.value = true;
}

const { toast } = useToast();

/**
 * Answers the list's clone ask: inspect the container, hand the wizard what it carried, open the
 * wizard. The default not started is part of the prefill, so the review is the last word before
 * anything runs.
 */
async function cloneContainer(container: ContainerSummary): Promise<void> {
  try {
    const detail = await containers.inspect(props.tab.id, container.id);
    if (detail === null) {
      return;
    }
    wizardPrefill.value = clonePrefillOf(container, detail);
    wizardOpen.value = true;
  } catch (failure) {
    toast(describeShellError(translate, asShellError(failure, "container_inspect")).message, "failure");
  }
}

/**
 * The wizard fields a container's inspect carries, the raw document answering for the rest: the
 * privileged switch, the capabilities, the labels, the networks and the weights and limits live
 * in it rather than in the curated detail. A raw document that will not parse costs those fields
 * — the curated ones still carry the prefill.
 */
function clonePrefillOf(container: ContainerSummary, detail: ContainerDetail): ContainerClonePrefill {
  let privileged = false;
  let shares: number | null = null;
  let memoryBytes: number | null = null;
  const capabilities: string[] = [];
  const labels: { name: string; value: string }[] = [];
  let networks: string[] = [];
  try {
    const raw = JSON.parse(detail.raw) as {
      HostConfig?: { Privileged?: boolean; CapAdd?: readonly string[]; CpuShares?: number; Memory?: number };
      Config?: { Labels?: Record<string, unknown> };
      NetworkSettings?: { Networks?: Record<string, unknown> };
    };
    privileged = raw.HostConfig?.Privileged === true;
    capabilities.push(...(raw.HostConfig?.CapAdd ?? []));
    if (typeof raw.HostConfig?.CpuShares === "number" && raw.HostConfig.CpuShares > 0) {
      shares = raw.HostConfig.CpuShares;
    }
    if (typeof raw.HostConfig?.Memory === "number" && raw.HostConfig.Memory > 0) {
      memoryBytes = raw.HostConfig.Memory;
    }
    for (const [name, value] of Object.entries(raw.Config?.Labels ?? {})) {
      labels.push({ name, value: String(value) });
    }
    networks = Object.keys(raw.NetworkSettings?.Networks ?? {});
  } catch {
    // The raw document is an enhancement: the curated fields carry a working prefill alone.
  }
  return {
    // The copy is a sibling, not a twin: the suffix keeps both names legal, and the wizard's own
    // grammar check has the final word.
    name: `${container.name}-copy`,
    image: detail.image,
    autostart: detail.restartPolicy === "always" || detail.restartPolicy === "unless-stopped",
    startNow: false,
    privileged,
    command: detail.command ?? "",
    ports: detail.ports.map((port) => ({
      hostPort: port.hostPort,
      containerPort: port.containerPort,
      protocol: port.protocol === "udp" ? ("udp" as const) : ("tcp" as const),
    })),
    volumes: detail.mounts.map((mount) => ({
      hostPath: mount.source,
      containerPath: mount.destination,
      readOnly: mount.readOnly,
    })),
    env: detail.env.map((line) => {
      const equals = line.indexOf("=");
      return equals === -1 ? { key: line, value: "" } : { key: line.slice(0, equals), value: line.slice(equals + 1) };
    }),
    labels,
    networks,
    capabilities,
    // The engine's three steps are 768/512/256; anything else (0 is the daemon's default) reads
    // as the middle choice, which the form makes explicitly anyway.
    cpuWeight: shares === 768 ? "high" : shares === 256 ? "low" : "mid",
    memoryLimitMb: memoryBytes === null ? null : String(Math.round(memoryBytes / (1024 * 1024))),
  };
}

async function loadWizardNetworks(): Promise<void> {
  const connectionId = session.value?.connectionId;
  if (!connectionId || session.value?.info?.networkAvailable === false) {
    wizardNetworks.value = [];
    return;
  }
  try {
    const networks = await backend.dockerNetworks.list(connectionId);
    wizardNetworks.value = networks.map((network) => ({ value: network.name, label: network.name }));
  } catch {
    wizardNetworks.value = [];
  }
}

watch(wizardOpen, (open) => {
  if (open) {
    void loadWizardNetworks();
  }
});

onMounted(() => {
  void containers.connect(props.tab);
});

onBeforeUnmount(() => {
  // Not `close`: the tab's own close path has already disconnected by `tab.connectionId`.
  containers.forget(props.tab.id);
});
</script>

<template>
  <section class="relative flex min-h-0 flex-1 flex-col">
    <!--
      The tab already names the session and its kind, so the strip carries only what the page alone
      can offer: a runtime with namespaces has the picker, and the desktop's containers page has the
      create wizard's entry — the one primary button the reference manager puts on that page's
      header. A runtime without namespaces and a flat layout get no strip, exactly as before.
    -->
    <!--
      Only the namespace picker lives here now: a runtime whose create entry sat alone on this row
      drew a full-width header for one button, while the containers page's own toolbar — where the
      reference manager puts the create action — already carries the entry through the list's
      `toolbar-end` slot.
    -->
    <header
      v-if="session?.connectionId && supportsNamespace(runtime)"
      class="flex shrink-0 items-center justify-end gap-2 border-b border-border px-3 py-[var(--panel-header-y)]"
    >
      <span class="shrink-0 text-[10px] text-muted-foreground">{{ t("container.namespace") }}</span>
      <Select
        :model-value="session.namespace"
        :options="namespaceOptions"
        size="compact"
        class="w-32"
        :aria-label="t('container.namespace')"
        @update:model-value="chooseNamespace"
      />
    </header>

    <!-- The connection as it is being made, and as it failed to be made. -->
    <div
      v-if="!session || (session.loading && session.connectionId === null)"
      class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
    >
      <LoaderCircle :size="16" class="animate-spin text-muted-foreground" />
      <p class="text-xs text-muted-foreground">{{ t("container.connecting") }}</p>
    </div>

    <!--
      The connection as it failed to be made, and the way back. The desktop layout keeps its rail
      beside the failure, and the rail offers the overview only — the pane's rule for an engine
      that is not there. The flat layout draws this block exactly as it always has.
    -->
    <div
      v-else-if="session.connectionId === null"
      class="flex min-h-0 flex-1"
      :class="desktop ? '' : 'flex-col items-center justify-center gap-2 p-6 text-center'"
    >
      <WbSideNav
        v-if="desktop"
        :items="sideRail"
        :active-id="view"
        :label="t('container.rail.label')"
        @select="view = $event as ContainerView"
      />
      <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <p class="text-xs text-muted-foreground">{{ t("container.connectFailed") }}</p>
        <p v-if="problem" class="max-w-xl text-xs text-destructive select-text">{{ problem.message }}</p>
        <p v-if="problemDetail" class="max-w-xl break-all text-[10px] text-destructive/90 select-text">
          {{ problemDetail }}
        </p>
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
    </div>

    <div v-else class="flex min-h-0 flex-1">
      <!--
        Two rails, one pane: the desktop window's 220px side navigation with count badges, and the
        application tab's compact one exactly as it has always been drawn.
      -->
      <WbSideNav
        v-if="desktop"
        :items="sideRail"
        :active-id="view"
        :label="t('container.rail.label')"
        @select="view = $event as ContainerView"
      />
      <nav
        v-else
        class="flex w-36 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-1.5"
        :aria-label="t('container.rail.label')"
      >
        <button
          v-for="item in rail"
          :key="item.view"
          type="button"
          :class="
            cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors',
              view === item.view
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )
          "
          :aria-current="view === item.view ? 'page' : undefined"
          @click="view = item.view"
        >
          <component :is="item.icon" :size="13" class="shrink-0" />
          <span class="min-w-0 flex-1 truncate text-left">{{ t(item.labelKey) }}</span>
          <span v-if="item.count !== null" class="shrink-0 font-mono text-[10px] text-muted-foreground">
            {{ item.count }}
          </span>
        </button>
      </nav>

      <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          v-if="problem"
          role="alert"
          class="flex shrink-0 items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 select-text"
        >
          <span class="min-w-0 flex-1">
            <span class="block text-[11px]">{{ problem.message }}</span>
            <span
              v-if="problemDetail"
              class="mt-0.5 block max-h-20 overflow-y-auto break-all text-[10px] text-destructive/90 select-text"
            >
              {{ problemDetail }}
            </span>
            <span class="mt-0.5 block font-mono text-[10px] text-muted-foreground">{{ problem.code }}</span>
          </span>
          <button
            type="button"
            class="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            :title="t('container.dismiss')"
            :aria-label="t('container.dismiss')"
            @click="dismiss()"
          >
            <X :size="11" />
          </button>
        </div>

        <!--
          All views stay mounted in either layout. The desktop's overview and image page draw from
          the same session the flat views do; which pair is visible is the layout's choice.

          The desktop's six pages keep the reference manager's floor: below the width its tables
          and forms are drawn for, the content scrolls sideways instead of squeezing every column
          into a sliver. The flat layout has no floor of its own — it is the arrangement this
          application has always drawn, and nothing about it changes.
        -->
        <!--
          No minimum width on this column: the toolbar must lay out at the width the window
          actually shows, or its right-end actions (create, refresh) scroll out of the frame with
          the table. The table carries its own min width and scrolls inside the list's scroller.
        -->
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
          <ContainerOverview
            v-show="!desktop && view === 'overview'"
            :tab="props.tab"
            :session="session"
            @show-state="showState"
            @show-images="view = 'images'"
          />
          <DockerOverview
            v-show="desktop && view === 'overview'"
            :tab="props.tab"
            :session="session"
            :active="props.active"
            @show-state="showState"
            @show-images="view = 'images'"
          />
          <!-- v-show, not v-if: a pull in progress and a filter being typed survive a view switch. -->
          <ContainerListView
            v-show="view === 'containers'"
            :tab="props.tab"
            :session="session"
            :layout="layout"
            :image-filter="imageFilter"
            :state-filter="stateFilter"
            @clear-image-filter="imageFilter = null"
            @clear-state-filter="stateFilter = null"
            @filter-state="stateFilter = $event"
            @clone="cloneContainer"
            @monitor="openMonitor"
            @upgrade="openUpgrade"
          >
            <!-- The create entry lives on the containers page's own toolbar, where the reference
                   manager puts it; the pane only owns the wizard it opens. The slot follows the
                   view, because the list stays mounted across views (v-show) and an entry that
                   only the containers page owns must not linger on the overview. -->
            <template v-if="desktop && view === 'containers'" #toolbar-end>
              <WbButton
                variant="primary"
                data-container-wizard-open
                @click="
                  wizardPrefill = null;
                  wizardOpen = true;
                "
              >
                {{ t("container.wizard.open") }}
              </WbButton>
            </template>
          </ContainerListView>
          <ContainerImageView
            v-show="!desktop && view === 'images'"
            :tab="props.tab"
            :session="session"
            @view-related="showRelatedContainers"
          />
          <DockerImages
            v-show="desktop && view === 'images'"
            :tab="props.tab"
            :session="session"
            @view-related="showRelatedContainers"
          />
          <!-- v-show, like the rest: a network the page was about to create survives a look away. -->
          <DockerNetworks v-show="desktop && view === 'networks'" :tab="props.tab" :session="session" />
          <DockerCompose v-show="desktop && view === 'compose'" :tab="props.tab" :session="session" />
          <!-- The volumes page reads and asks about removals; the cleanup page reads first and
               prunes second. Both stay mounted across views like every other page here. -->
          <DockerVolumes v-show="desktop && view === 'volumes'" :session="session" />
          <DockerCleanup v-show="desktop && view === 'cleanup'" :session="session" />
        </div>
      </div>
    </div>

    <!--
      The create wizard lives over this pane, wherever in the desktop's rail the reader is: it is a
      modal of the window, not a view of the rail. The network choices are the engine's own, read
      when the wizard opens; an engine that does not answer the listing leaves the field on its
      typed-names degrade.
    -->
    <ContainerWizard
      v-if="desktop"
      :open="wizardOpen"
      :tab-id="props.tab.id"
      :network-options="wizardNetworks"
      :prefill="wizardPrefill"
      @update:open="wizardOpen = $event"
    />

    <!-- One container's own lines: the same sampling discipline as the overview, one row of stats. -->
    <ContainerMonitorDialog
      v-if="desktop && session !== undefined"
      :open="monitorOpen"
      :session="session"
      :target="monitorTarget"
      :active="props.active"
      @close="monitorOpen = false"
    />

    <!--
      The upgrade transaction, wherever in the rail the reader is: a modal of the window, not a
      view of it. The dialog reads the container and asks the registry itself; the pull-first order
      and the recovery after the removal are the transaction's own contract.
    -->
    <ContainerUpgradeDialog
      v-if="desktop && session !== undefined"
      :open="upgradeOpen"
      :tab-id="props.tab.id"
      :session="session"
      :target="upgradeTarget"
      @update:open="upgradeOpen = $event"
    />
  </section>
</template>
