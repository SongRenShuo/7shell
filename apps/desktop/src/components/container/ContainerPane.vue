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
import { Boxes, Gauge, Layers, LoaderCircle, RotateCw, X } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import DockerImages from "@/components/container/DockerImages.vue";
import DockerOverview from "@/components/container/DockerOverview.vue";
import WbSideNav, { type SideNavItem } from "@/components/container/WbSideNav.vue";
import Select from "@/components/ui/Select.vue";
import { describeShellError } from "@/i18n/errors";
import { cn } from "@/lib/utils";
import { supportsNamespace, useContainerStore } from "@/stores/container";
import type { ContainerTab } from "@/stores/terminals";

import ContainerImageView from "./ContainerImageView.vue";
import ContainerListView from "./ContainerListView.vue";
import ContainerOverview from "./ContainerOverview.vue";

const props = withDefaults(
  defineProps<{
    tab: ContainerTab;
    active: boolean;
    /** `flat` is the application tab's workspace; `desktop` is the desktop window's. */
    layout?: "desktop" | "flat";
  }>(),
  { layout: "flat" },
);

type ContainerView = "overview" | "containers" | "images";

const { t } = useI18n();
const containers = useContainerStore();

const desktop = computed(() => props.layout === "desktop");

const view = ref<ContainerView>("overview");
/** Set when the images view asked to see which containers run an image. */
const imageFilter = ref<string | null>(null);
/** Set when the overview's state counts were clicked. */
const stateFilter = ref<string | null>(null);

const session = computed(() => containers.sessionFor(props.tab.id));
const runtime = computed(() => props.tab.session.container?.runtime ?? "docker");
const problem = computed(() => (session.value?.error ? describeShellError(translate, session.value.error) : null));

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
 * The desktop rail's rows, and the rule it carries: an engine this session has not reached — not
 * connected yet, or failed to — offers the overview and nothing else. There is nothing to count
 * and nowhere to go, and a rail that pretended otherwise would be drawing buttons for an engine
 * that is not there.
 */
const sideRail = computed<readonly SideNavItem[]>(() => {
  const current = session.value;
  const connected = current !== undefined && current.connectionId !== null;
  const overview: SideNavItem = { id: "overview", label: t("container.rail.overview"), icon: Gauge, count: null };
  if (!connected) {
    return [overview];
  }
  return [
    overview,
    { id: "containers", label: t("container.rail.containers"), icon: Boxes, count: current.containers.length },
    { id: "images", label: t("container.rail.images"), icon: Layers, count: current.images.length },
  ];
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
      can offer: a runtime with namespaces has the picker, and one without them has nothing and gets
      no strip at all.
    -->
    <header
      v-if="supportsNamespace(runtime) && session?.connectionId"
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
        -->
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
        />
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
      </div>
    </div>
  </section>
</template>
