<script setup lang="ts">
/**
 * The Docker window's networks page: the engine's networks, what they carry, and the one way a
 * person makes or loses one.
 *
 * The columns are the readings the reference manager keeps — the driver a network rides, the
 * subnet and gateway it was given, whether IPv6 is on, and how many containers hold it — and the
 * count is the removal question's own answer: a network with containers on it is refused by the
 * engine, so the confirm says what will happen and the refusal, when it comes, says how many.
 *
 * The list is read when the page opens and when the refresh is pressed, and at no other time: a
 * network is made by somebody's own hand, so a list that refreshed itself would be guessing. The
 * failures land on this page's own strip, in the words the error catalog keeps for the code —
 * including the guardrail's own sentence, which names the network and the count.
 */
import { Ellipsis, LoaderCircle, RotateCw, X } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import Select from "@/components/ui/Select.vue";
import WbButton from "@/components/ui/WbButton.vue";
import WbEmpty from "@/components/ui/WbEmpty.vue";
import { useContextMenu } from "@/composables/useContextMenu";
import { describeShellError } from "@/i18n/errors";
import { backend } from "@/lib/backend/api";
import { asShellError, type ShellError } from "@/lib/backend/errors";
import type { MenuEntry } from "@/lib/menu/types";
import { TABLE, rowClass } from "@/lib/table";
import { cn } from "@/lib/utils";
import type { ContainerSession } from "@/stores/container";
import type { ContainerTab } from "@/stores/terminals";
import type { NetworkSummary } from "@/types/container";

import ContainerDialog from "./ContainerDialog.vue";
import { filterNetworks, isValidCidr, isValidGateway, isValidNetworkName } from "./networks";

const props = defineProps<{ tab: ContainerTab; session: ContainerSession }>();

const { t } = useI18n();
const { openMenu } = useContextMenu();

// -- the list -------------------------------------------------------------------

const networks = ref<NetworkSummary[]>([]);
const loading = ref(false);
const failure = ref<ShellError | null>(null);
const text = ref("");

const rows = computed(() => filterNetworks(networks.value, text.value));

function translate(key: string, params?: Record<string, string>): string {
  return params ? t(key, params) : t(key);
}

function describe(error: ShellError): string {
  return describeShellError(translate, error).message;
}

/**
 * Reads the list once. Called when the page mounts and when the refresh is pressed — and never
 * from a timer, because a network does not appear by itself.
 */
async function load(): Promise<void> {
  const connectionId = props.session.connectionId;
  if (connectionId === null || loading.value) {
    return;
  }
  loading.value = true;
  try {
    const answer = await backend.dockerNetworks.list(connectionId);
    // A session that was replaced while the read was on its way does not get its answer.
    if (props.session.connectionId === connectionId) {
      networks.value = answer;
      failure.value = null;
    }
  } catch (error) {
    if (props.session.connectionId === connectionId) {
      failure.value = asShellError(error, "network_list");
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

// -- the row's menu and removal ---------------------------------------------------

const removing = ref<NetworkSummary | null>(null);

function openRowMenu(event: MouseEvent, network: NetworkSummary): void {
  const entries: MenuEntry[] = [
    {
      kind: "action",
      id: "remove",
      labelKey: "container.desktop.networks.remove",
      danger: true,
      run: () => {
        removing.value = network;
      },
    },
  ];
  openMenu(event, { key: "container.desktop.networks.menu", params: { name: network.name } }, entries);
}

async function removeNetwork(): Promise<void> {
  const network = removing.value;
  removing.value = null;
  const connectionId = props.session.connectionId;
  if (!network || connectionId === null) {
    return;
  }
  try {
    await backend.dockerNetworks.remove(connectionId, network.name);
    failure.value = null;
    void load();
  } catch (error) {
    // A network still in use is refused with the catalog's own sentence, which names the network
    // and the count — the page draws exactly that, on its strip. Nothing changed on the engine,
    // so nothing is read again: a reload here would wipe the refusal nobody has read yet.
    failure.value = asShellError(error, "network_remove");
  }
}

// -- the create dialog ------------------------------------------------------------

const DRIVER_OPTIONS = ["bridge", "host", "macvlan", "overlay", "none"].map((value) => ({ value, label: value }));

const creatingOpen = ref(false);
const createName = ref("");
const createDriver = ref("bridge");
const createSubnet = ref("");
const createGateway = ref("");
const createBusy = ref(false);

function openCreate(): void {
  createName.value = "";
  createDriver.value = "bridge";
  createSubnet.value = "";
  createGateway.value = "";
  createBusy.value = false;
  creatingOpen.value = true;
}

/** Said only when it is true: an untouched field is not an error. */
const nameProblem = computed(() =>
  createName.value.trim() === "" || isValidNetworkName(createName.value.trim())
    ? null
    : t("container.desktop.networks.nameInvalid"),
);
const subnetProblem = computed(() =>
  createSubnet.value.trim() === "" || isValidCidr(createSubnet.value.trim())
    ? null
    : t("container.desktop.networks.subnetInvalid"),
);
const gatewayProblem = computed(() =>
  createGateway.value.trim() === "" || isValidGateway(createGateway.value.trim())
    ? null
    : t("container.desktop.networks.gatewayInvalid"),
);
const createReady = computed(
  () =>
    createName.value.trim() !== "" &&
    nameProblem.value === null &&
    subnetProblem.value === null &&
    gatewayProblem.value === null &&
    !createBusy.value,
);

async function submitCreate(): Promise<void> {
  const connectionId = props.session.connectionId;
  if (!createReady.value || connectionId === null) {
    return;
  }
  createBusy.value = true;
  try {
    const subnet = createSubnet.value.trim();
    const gateway = createGateway.value.trim();
    await backend.dockerNetworks.create(connectionId, {
      name: createName.value.trim(),
      driver: createDriver.value === "bridge" ? undefined : createDriver.value,
      ...(subnet !== "" ? { subnet } : {}),
      ...(gateway !== "" ? { gateway } : {}),
    });
    creatingOpen.value = false;
    failure.value = null;
    void load();
  } catch (error) {
    // A refused create changed nothing on the engine; the strip says so and the list stands.
    failure.value = asShellError(error, "network_create");
  } finally {
    createBusy.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The page head: the reference's own measure — the page's name bold, the 300px search, the
         primary action at the far end. -->
    <div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <h2 class="shrink-0 text-lg font-bold leading-none">{{ t("container.rail.networks") }}</h2>
      <input
        v-model="text"
        type="text"
        spellcheck="false"
        class="h-7 w-[300px] rounded-sm border border-border bg-background px-2.5 text-xs focus:outline-none"
        :placeholder="t('container.desktop.networks.search')"
        :aria-label="t('container.desktop.networks.search')"
      />
      <div class="min-w-0 flex-1"></div>
      <WbButton variant="primary" data-networks-create @click="openCreate()">
        {{ t("container.desktop.networks.create") }}
      </WbButton>
      <button
        type="button"
        class="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--workbench-on-picture)_6%,transparent)] hover:text-foreground"
        :title="t('container.refresh')"
        :aria-label="t('container.refresh')"
        data-networks-refresh
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
      data-networks-failure
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

    <div class="min-h-0 flex-1 overflow-auto px-3">
      <p
        v-if="loading && networks.length === 0"
        class="flex items-center gap-1.5 px-1 py-3 text-[11px] text-muted-foreground"
        data-networks-loading
      >
        <LoaderCircle :size="12" class="animate-spin" />
        {{ t("container.desktop.networks.loading") }}
      </p>
      <table
        v-else
        :class="cn(TABLE.page.table, 'table-fixed')"
        :style="{ minWidth: '720px' }"
        :aria-label="t('container.rail.networks')"
      >
        <thead :class="TABLE.page.head">
          <tr :class="TABLE.page.headRow">
            <th class="w-[24%]" :class="TABLE.page.headCell">{{ t("container.col.name") }}</th>
            <th class="w-[14%]" :class="TABLE.page.headCell">{{ t("container.desktop.networks.driver") }}</th>
            <th class="w-[20%]" :class="TABLE.page.headCell">{{ t("container.desktop.networks.subnet") }}</th>
            <th class="w-[16%]" :class="TABLE.page.headCell">{{ t("container.desktop.networks.gateway") }}</th>
            <th class="w-[10%]" :class="TABLE.page.headCell">IPv6</th>
            <th class="w-[12%]" :class="TABLE.page.headCell">{{ t("container.desktop.networks.containers") }}</th>
            <th class="w-[3rem]" :class="TABLE.page.headCell">{{ t("container.col.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="network in rows"
            :key="network.name"
            :class="cn(rowClass('page', { clickable: true, striped: true }))"
          >
            <td :class="TABLE.page.cell">
              <span class="block truncate font-mono text-[11px]" :title="network.name">{{ network.name }}</span>
            </td>
            <td :class="TABLE.page.cell">
              <span class="block truncate font-mono text-[11px]">{{ network.driver }}</span>
            </td>
            <td :class="TABLE.page.cell">
              <span class="block truncate font-mono text-[11px]" :title="network.subnet">
                {{ network.subnet !== "" ? network.subnet : "—" }}
              </span>
            </td>
            <td :class="TABLE.page.cell">
              <span class="block truncate font-mono text-[11px]" :title="network.gateway">
                {{ network.gateway !== "" ? network.gateway : "—" }}
              </span>
            </td>
            <td :class="TABLE.page.cell">
              <span class="block font-mono text-[11px]">{{ network.ipv6 ? "IPv6" : "—" }}</span>
            </td>
            <td :class="TABLE.page.cell">
              <span class="block font-mono text-[11px]" data-networks-container-count>{{ network.containers }}</span>
            </td>
            <td :class="TABLE.page.cell">
              <button
                type="button"
                class="grid size-5 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--workbench-on-picture)_6%,transparent)] hover:text-foreground"
                :title="t('container.desktop.networks.menu', { name: network.name })"
                :aria-label="t('container.desktop.networks.menu', { name: network.name })"
                @click="openRowMenu($event, network)"
              >
                <Ellipsis :size="12" />
              </button>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td :colspan="7" :class="cn(TABLE.page.cell, TABLE.page.emptyCell)">
              <WbEmpty
                scenario="noData"
                size="sm"
                :description="
                  text.trim() === '' ? t('container.desktop.networks.none') : t('container.desktop.networks.noMatch')
                "
                class="mx-auto"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!--
      A new network: a name, the driver, and — optional, because Docker picks both when they are
      left out — the subnet and gateway. The addresses are checked while they are typed; the check
      refuses the shapes no engine would accept and leaves the arguable ones to the engine.
    -->
    <ContainerDialog
      :open="creatingOpen"
      :title="t('container.desktop.networks.createTitle')"
      :busy="createBusy"
      @update:open="creatingOpen = $event"
    >
      <label class="flex flex-col gap-1">
        <span class="text-[11px] text-muted-foreground">{{ t("container.desktop.networks.nameLabel") }}</span>
        <input
          v-model="createName"
          type="text"
          spellcheck="false"
          data-networks-name
          class="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
          :class="nameProblem ? 'border-destructive' : ''"
          :placeholder="t('container.desktop.networks.namePlaceholder')"
          :aria-label="t('container.desktop.networks.nameLabel')"
        />
        <span v-if="nameProblem" class="text-[10px] text-destructive">{{ nameProblem }}</span>
      </label>

      <label class="mt-2 flex flex-col gap-1">
        <span class="text-[11px] text-muted-foreground">{{ t("container.desktop.networks.driver") }}</span>
        <Select
          v-model="createDriver"
          :options="DRIVER_OPTIONS"
          class="w-44"
          :aria-label="t('container.desktop.networks.driver')"
        />
      </label>

      <label class="mt-2 flex flex-col gap-1">
        <span class="text-[11px] text-muted-foreground">{{ t("container.desktop.networks.subnet") }}</span>
        <input
          v-model="createSubnet"
          type="text"
          spellcheck="false"
          data-networks-subnet
          class="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
          :class="subnetProblem ? 'border-destructive' : ''"
          :placeholder="t('container.desktop.networks.subnetPlaceholder')"
          :aria-label="t('container.desktop.networks.subnet')"
        />
        <span v-if="subnetProblem" class="text-[10px] text-destructive">{{ subnetProblem }}</span>
        <span v-else class="text-[10px] text-muted-foreground">{{ t("container.desktop.networks.subnetHint") }}</span>
      </label>

      <label class="mt-2 flex flex-col gap-1">
        <span class="text-[11px] text-muted-foreground">{{ t("container.desktop.networks.gateway") }}</span>
        <input
          v-model="createGateway"
          type="text"
          spellcheck="false"
          data-networks-gateway
          class="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
          :class="gatewayProblem ? 'border-destructive' : ''"
          :placeholder="t('container.desktop.networks.gatewayPlaceholder')"
          :aria-label="t('container.desktop.networks.gateway')"
        />
        <span v-if="gatewayProblem" class="text-[10px] text-destructive">{{ gatewayProblem }}</span>
        <span v-else class="text-[10px] text-muted-foreground">{{ t("container.desktop.networks.gatewayHint") }}</span>
      </label>

      <template #footer>
        <WbButton @click="creatingOpen = false">{{ t("common.action.cancel") }}</WbButton>
        <WbButton
          variant="primary"
          :busy="createBusy"
          :disabled="!createReady"
          data-networks-submit
          @click="submitCreate()"
        >
          {{ createBusy ? t("container.desktop.networks.creating") : t("container.desktop.networks.submit") }}
        </WbButton>
      </template>
    </ContainerDialog>

    <!--
      Removal keeps the workspace's gate: the confirmation carries the consequence — including the
      engine's own guardrail, which has the last word while a container still holds the network.
    -->
    <ConfirmDialog
      :open="removing !== null"
      :title="t('container.desktop.networks.removeTitle', { name: removing?.name ?? '' })"
      :message="t('container.desktop.networks.removeMessage')"
      :confirm-label="t('container.desktop.networks.removeVerb')"
      danger
      @confirm="removeNetwork()"
      @update:open="removing = null"
    />
  </div>
</template>
