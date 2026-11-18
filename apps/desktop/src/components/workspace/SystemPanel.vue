<script setup lang="ts">
/**
 * The machine's own details, as a panel inside the desktop.
 *
 * The monitor beside the workspace answers "how busy is this machine" with a sample every couple
 * of seconds. This is the slower, wider read underneath it: which services exist and what state
 * they are in, how the disks are carved up, who can log in, how the network is addressed, and what
 * the journal has said lately. All five are fixed read-only commands with nothing anybody typed —
 * the same rule the monitor's four constants live by.
 *
 * Three decisions are worth knowing:
 *
 * 1. **One read on open, then a refresh somebody asks for.** Nothing here is a live meter, and a
 *    panel that re-read five remote commands on a clock would be a cost paid by the machine for a
 *    page that is mostly not being looked at.
 * 2. **A section the host could not answer is empty with a sentence, never a zero.** A container
 *    without systemd has no services and no journal; saying so is the honest reading.
 * 3. **The journal can be asked for more, and asks once each time.** It is a tail of fixed size,
 *    and the button that grows it is a person's decision rather than a stream.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Boxes, HardDrive, LoaderCircle, Network, RefreshCw, ScrollText, Users, X } from "@lucide/vue";

import { describeShellError } from "@/i18n/errors";
import { useToast } from "@/composables/useToast";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import { backend } from "@/lib/backend/api";
import { asShellError, type ShellError } from "@/lib/backend/errors";
import { formatSize } from "@/lib/files/format";
import { TABLE, rowClass } from "@/lib/table";
import { cn } from "@/lib/utils";
import type { DiskDevice, JournalTail, SystemOverview } from "@/types/sysinfo";

const props = defineProps<{
  /** The session a policy decision about a service names. */
  sessionId: string;
  /** The SSH connection the reads ride on — the desktop tab's own, as every file surface does. */
  handle: string;
  /** Whether the panel is the one on screen; a hidden panel does not re-read. */
  active: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

type Section = "services" | "disks" | "accounts" | "network" | "journal";

const { t } = useI18n();

const section = ref<Section>("services");
const overview = ref<SystemOverview | null>(null);
const journal = ref<JournalTail | null>(null);
const reading = ref(false);
const { toast } = useToast();
const busyUnit = ref<string | null>(null);

/**
 * The stop question, which is the one verb that asks here.
 *
 * Starting and restarting go through the policy matrix too — the shell refuses an unacknowledged
 * action either way — but interrupting a service is the one a person should read a sentence about
 * before it happens, so the panel asks in its own words and passes the answer along.
 */
const askingStop = ref<{ unit: string } | null>(null);
const failure = ref<ShellError | null>(null);
const journalLines = ref(200);

const sections = computed(() => [
  { id: "services" as const, label: t("workbench.system.sections.services"), icon: Boxes },
  { id: "disks" as const, label: t("workbench.system.sections.disks"), icon: HardDrive },
  { id: "accounts" as const, label: t("workbench.system.sections.accounts"), icon: Users },
  { id: "network" as const, label: t("workbench.system.sections.network"), icon: Network },
  { id: "journal" as const, label: t("workbench.system.sections.journal"), icon: ScrollText },
]);

const readable = computed(() => (failure.value ? describeShellError(t, failure.value).message : null));

/** What the header says about the machine, from the overview's own four scalars. */
const facts = computed(() => {
  const o = overview.value;
  if (!o) {
    return [];
  }
  const rows: { label: string; value: string }[] = [];
  if (o.distribution) rows.push({ label: t("workbench.system.facts.distribution"), value: o.distribution });
  if (o.kernel) rows.push({ label: t("workbench.system.facts.kernel"), value: o.kernel });
  rows.push({ label: t("workbench.system.facts.uptime"), value: uptime(o.uptimeSeconds) });
  if (o.timezone) rows.push({ label: t("workbench.system.facts.timezone"), value: o.timezone });
  return rows;
});

function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return t("workbench.system.uptime.days", { days, hours });
  if (hours > 0) return t("workbench.system.uptime.hours", { hours, minutes });
  return t("workbench.system.uptime.minutes", { minutes });
}

/** A device and its partitions, flattened for the table, in the host's own order. */
function flatten(devices: readonly DiskDevice[] | undefined, depth = 0): { device: DiskDevice; depth: number }[] {
  const rows: { device: DiskDevice; depth: number }[] = [];
  for (const device of devices ?? []) {
    rows.push({ device, depth });
    // A leaf device carries no `children` key at all rather than an empty list.
    rows.push(...flatten(device.children, depth + 1));
  }
  return rows;
}

const diskRows = computed(() => flatten(overview.value?.disks ?? []));

/** Services worth reading first: failed ones, then the ones running. */
const services = computed(() => {
  const list = overview.value?.services ?? [];
  return [...list].sort((left, right) => {
    const rank = (service: { active: string }) =>
      service.active === "failed" ? 0 : service.active === "active" ? 1 : 2;
    return rank(left) - rank(right) || left.name.localeCompare(right.name);
  });
});

const accounts = computed(() => {
  const list = overview.value?.accounts ?? [];
  return [...list].sort((left, right) => left.uid - right.uid);
});

/** One verb on one unit. The acknowledgement is `verb !== "stop"`, because only stop asks. */
async function act(unit: string, verb: "start" | "restart" | "stop"): Promise<void> {
  if (verb === "stop") {
    askingStop.value = { unit };
    return;
  }
  await issue(unit, verb, true);
}

async function issue(unit: string, verb: string, acknowledged: boolean): Promise<void> {
  busyUnit.value = unit;
  try {
    await backend.system.serviceAction(props.sessionId, props.handle, unit, verb, acknowledged);
    toast(t("workbench.system.serviceActions.issued", { unit, verb }), "receipt");
    // The list is a read, so it is read again — the unit somebody just touched should show the
    // state it is actually in rather than the one it was in a moment ago.
    await read();
  } catch (error) {
    toast(describeShellError(t, asShellError(error, "system_service_action")).message, "failure");
  } finally {
    busyUnit.value = null;
  }
}

/** The stop question answered yes. */
async function confirmStop(): Promise<void> {
  const target = askingStop.value;
  askingStop.value = null;
  if (target) {
    await issue(target.unit, "stop", true);
  }
}

async function read(): Promise<void> {
  if (!props.active) {
    return;
  }
  reading.value = true;
  try {
    overview.value = await backend.system.overview(props.handle);
    failure.value = null;
  } catch (error) {
    failure.value = asShellError(error, "system_overview");
  } finally {
    reading.value = false;
  }
  if (section.value === "journal") {
    await readJournal();
  }
}

async function readJournal(): Promise<void> {
  try {
    journal.value = await backend.system.journal(props.handle, journalLines.value);
  } catch (error) {
    failure.value = asShellError(error, "system_journal");
  }
}

function choose(next: Section): void {
  section.value = next;
  if (next === "journal" && journal.value === null) {
    void readJournal();
  }
}

function moreJournal(): void {
  journalLines.value = Math.min(500, journalLines.value + 200);
  void readJournal();
}

// Read when the panel becomes the one on screen, and when the connection under it changes. Never
// on a clock: none of these answers changes by itself in a way anybody is watching for.
watch(
  () => [props.active, props.handle] as const,
  () => void read(),
  { immediate: true },
);
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col" data-workbench-system>
    <header class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
      <Boxes :size="13" class="text-muted-foreground" />
      <span class="text-xs font-medium">{{ t("workbench.system.title") }}</span>
      <span class="flex-1" />
      <button
        type="button"
        class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        :title="t('workbench.system.refresh')"
        :disabled="reading"
        @click="read()"
      >
        <RefreshCw :size="12" :class="reading ? 'animate-spin' : ''" />
      </button>
      <button
        type="button"
        class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        :title="t('common.action.close')"
        @click="emit('close')"
      >
        <X :size="12" />
      </button>
    </header>

    <p v-if="readable" class="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-[11px]">
      {{ readable }}
    </p>

    <nav class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1" data-workbench-system-tabs>
      <button
        v-for="entry in sections"
        :key="entry.id"
        type="button"
        class="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[11px] transition-colors"
        :class="
          section === entry.id
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
        "
        @click.stop="choose(entry.id)"
      >
        <component :is="entry.icon" :size="11" />
        {{ entry.label }}
      </button>
      <span class="min-w-2 flex-1" />
      <span
        v-for="fact in facts"
        :key="fact.label"
        class="hidden shrink-0 truncate whitespace-nowrap text-[11px] text-muted-foreground lg:inline"
      >
        {{ fact.label }} <span class="text-foreground/80">{{ fact.value }}</span>
      </span>
    </nav>

    <div class="min-h-0 flex-1 overflow-auto px-3 py-2">
      <div
        v-if="reading && !overview"
        class="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground"
      >
        <LoaderCircle :size="14" class="animate-spin" />
        {{ t("workbench.system.reading") }}
      </div>

      <!-- Services: what is running, what failed, and what is not running at all. -->
      <table
        v-else-if="section === 'services'"
        :class="TABLE.page.table"
        :aria-label="t('workbench.system.sections.services')"
      >
        <thead :class="TABLE.page.head">
          <tr :class="TABLE.page.headRow">
            <th :class="cn(TABLE.page.headCell, 'text-left')">{{ t("workbench.system.services.name") }}</th>
            <th :class="cn(TABLE.page.headCell, 'w-20 text-left')">{{ t("workbench.system.services.load") }}</th>
            <th :class="cn(TABLE.page.headCell, 'w-20 text-left')">{{ t("workbench.system.services.active") }}</th>
            <th :class="cn(TABLE.page.headCell, 'w-20 text-left')">{{ t("workbench.system.services.sub") }}</th>
            <th :class="cn(TABLE.page.headCell, 'text-left')">{{ t("workbench.system.services.description") }}</th>
            <th :class="cn(TABLE.page.headCell, 'w-32 text-right')">{{ t("workbench.system.services.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="service in services" :key="service.name" :class="rowClass('page')">
            <td :class="cn(TABLE.page.cell, 'truncate font-mono text-[11px]')" :title="service.name">
              {{ service.name }}
            </td>
            <td :class="cn(TABLE.page.cell, 'text-muted-foreground')">{{ service.load }}</td>
            <td
              :class="
                cn(
                  TABLE.page.cell,
                  service.active === 'failed'
                    ? 'text-destructive'
                    : service.active === 'active'
                      ? 'text-foreground'
                      : 'text-muted-foreground',
                )
              "
            >
              {{ service.active }}
            </td>
            <td :class="cn(TABLE.page.cell, 'text-muted-foreground')">{{ service.sub }}</td>
            <td :class="cn(TABLE.page.cell, 'truncate text-muted-foreground')" :title="service.description">
              {{ service.description }}
            </td>
            <td :class="cn(TABLE.page.cell, 'whitespace-nowrap text-right')">
              <span class="inline-flex items-center gap-1">
                <button
                  type="button"
                  class="rounded-md px-1.5 py-0.5 text-[11px] transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="busyUnit === service.name || service.active === 'active'"
                  :title="t('workbench.system.serviceActions.start')"
                  @click="act(service.name, 'start')"
                >
                  {{ t("workbench.system.serviceActions.start") }}
                </button>
                <button
                  type="button"
                  class="rounded-md px-1.5 py-0.5 text-[11px] transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="busyUnit === service.name || service.active !== 'active'"
                  :title="t('workbench.system.serviceActions.restart')"
                  @click="act(service.name, 'restart')"
                >
                  {{ t("workbench.system.serviceActions.restart") }}
                </button>
                <button
                  type="button"
                  class="rounded-md px-1.5 py-0.5 text-[11px] text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="busyUnit === service.name || service.active !== 'active'"
                  :title="t('workbench.system.serviceActions.stop')"
                  @click="act(service.name, 'stop')"
                >
                  {{ t("workbench.system.serviceActions.stop") }}
                </button>
              </span>
            </td>
          </tr>
          <tr v-if="services.length === 0">
            <td :colspan="6" :class="TABLE.page.emptyCell">{{ t("workbench.system.services.empty") }}</td>
          </tr>
        </tbody>
      </table>

      <!-- Disks: the whole block-device tree, indented by depth. -->
      <table
        v-else-if="section === 'disks'"
        :class="TABLE.page.table"
        :aria-label="t('workbench.system.sections.disks')"
      >
        <thead :class="TABLE.page.head">
          <tr :class="TABLE.page.headRow">
            <th :class="cn(TABLE.page.headCell, 'text-left')">{{ t("workbench.system.disks.name") }}</th>
            <th :class="cn(TABLE.page.headCell, 'w-24 text-right')">{{ t("workbench.system.disks.size") }}</th>
            <th :class="cn(TABLE.page.headCell, 'w-20 text-left')">{{ t("workbench.system.disks.kind") }}</th>
            <th :class="cn(TABLE.page.headCell, 'w-24 text-left')">{{ t("workbench.system.disks.filesystem") }}</th>
            <th :class="cn(TABLE.page.headCell, 'text-left')">{{ t("workbench.system.disks.mount") }}</th>
            <th :class="cn(TABLE.page.headCell, 'text-left')">{{ t("workbench.system.disks.model") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in diskRows" :key="row.device.name" :class="rowClass('page')">
            <td :class="cn(TABLE.page.cell, 'font-mono text-[11px]')">
              <span :style="{ paddingLeft: `${row.depth * 14}px` }">{{ row.device.name }}</span>
            </td>
            <td :class="cn(TABLE.page.cell, 'text-right font-mono text-[11px]')">{{ row.device.size }}</td>
            <td :class="cn(TABLE.page.cell, 'text-muted-foreground')">{{ row.device.kind }}</td>
            <td :class="cn(TABLE.page.cell, 'font-mono text-[11px] text-muted-foreground')">
              {{ row.device.filesystem ?? "-" }}
            </td>
            <td :class="cn(TABLE.page.cell, 'truncate font-mono text-[11px]')" :title="row.device.mount ?? ''">
              {{ row.device.mount ?? "-" }}
            </td>
            <td :class="cn(TABLE.page.cell, 'truncate text-muted-foreground')" :title="row.device.model ?? ''">
              {{ row.device.model ?? "-" }}
            </td>
          </tr>
          <tr v-if="diskRows.length === 0">
            <td :colspan="6" :class="TABLE.page.emptyCell">{{ t("workbench.system.disks.empty") }}</td>
          </tr>
        </tbody>
      </table>

      <!-- Accounts: who can log in, and who is logged in now. -->
      <table
        v-else-if="section === 'accounts'"
        :class="TABLE.page.table"
        :aria-label="t('workbench.system.sections.accounts')"
      >
        <thead :class="TABLE.page.head">
          <tr :class="TABLE.page.headRow">
            <th :class="cn(TABLE.page.headCell, 'text-left')">{{ t("workbench.system.accounts.user") }}</th>
            <th :class="cn(TABLE.page.headCell, 'w-16 text-right')">{{ t("workbench.system.accounts.uid") }}</th>
            <th :class="cn(TABLE.page.headCell, 'w-16 text-right')">{{ t("workbench.system.accounts.gid") }}</th>
            <th :class="cn(TABLE.page.headCell, 'text-left')">{{ t("workbench.system.accounts.home") }}</th>
            <th :class="cn(TABLE.page.headCell, 'text-left')">{{ t("workbench.system.accounts.shell") }}</th>
            <th :class="cn(TABLE.page.headCell, 'w-24 text-left')">{{ t("workbench.system.accounts.loggedIn") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="account in accounts" :key="account.user" :class="rowClass('page')">
            <td :class="cn(TABLE.page.cell, 'font-mono text-[11px]')">
              {{ account.user }}
              <span v-if="account.isRoot" class="ml-1 rounded bg-destructive/15 px-1 text-[10px] text-destructive"
                >root</span
              >
            </td>
            <td :class="cn(TABLE.page.cell, 'text-right font-mono text-[11px] text-muted-foreground')">
              {{ account.uid }}
            </td>
            <td :class="cn(TABLE.page.cell, 'text-right font-mono text-[11px] text-muted-foreground')">
              {{ account.gid }}
            </td>
            <td :class="cn(TABLE.page.cell, 'truncate font-mono text-[11px]')">{{ account.home }}</td>
            <td :class="cn(TABLE.page.cell, 'truncate font-mono text-[11px] text-muted-foreground')">
              {{ account.shell }}
            </td>
            <td :class="cn(TABLE.page.cell, account.loggedIn ? 'text-foreground' : 'text-muted-foreground')">
              {{ account.loggedIn ? t("workbench.system.accounts.online") : "-" }}
            </td>
          </tr>
          <tr v-if="accounts.length === 0">
            <td :colspan="6" :class="TABLE.page.emptyCell">{{ t("workbench.system.accounts.empty") }}</td>
          </tr>
        </tbody>
      </table>

      <!-- Network: interfaces with their addresses, then routes, then resolvers. -->
      <div v-else-if="section === 'network'" class="flex flex-col gap-4">
        <div>
          <h3 class="mb-1 text-[11px] font-medium text-muted-foreground">
            {{ t("workbench.system.network.interfaces") }}
          </h3>
          <table :class="TABLE.page.table" :aria-label="t('workbench.system.network.interfaces')">
            <thead :class="TABLE.page.head">
              <tr :class="TABLE.page.headRow">
                <th :class="cn(TABLE.page.headCell, 'text-left')">{{ t("workbench.system.network.name") }}</th>
                <th :class="cn(TABLE.page.headCell, 'w-20 text-left')">{{ t("workbench.system.network.state") }}</th>
                <th :class="cn(TABLE.page.headCell, 'text-left')">{{ t("workbench.system.network.addresses") }}</th>
                <th :class="cn(TABLE.page.headCell, 'w-40 text-right')">{{ t("workbench.system.network.traffic") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="iface in overview?.interfaces ?? []" :key="iface.name" :class="rowClass('page')">
                <td :class="cn(TABLE.page.cell, 'font-mono text-[11px]')">{{ iface.name }}</td>
                <td :class="cn(TABLE.page.cell, iface.state === 'UP' ? 'text-foreground' : 'text-muted-foreground')">
                  {{ iface.state }}
                </td>
                <td :class="cn(TABLE.page.cell, 'font-mono text-[11px]')">
                  <span v-if="iface.addresses.length === 0" class="text-muted-foreground">-</span>
                  <span v-for="address in iface.addresses" :key="address.address" class="mr-3 whitespace-nowrap">
                    {{ address.address }}/{{ address.prefix }}
                  </span>
                </td>
                <td :class="cn(TABLE.page.cell, 'text-right font-mono text-[11px] text-muted-foreground')">
                  ↑{{ formatSize(iface.txBytes) }} ↓{{ formatSize(iface.rxBytes) }}
                </td>
              </tr>
              <tr v-if="(overview?.interfaces.length ?? 0) === 0">
                <td :colspan="4" :class="TABLE.page.emptyCell">{{ t("workbench.system.network.empty") }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div>
          <h3 class="mb-1 text-[11px] font-medium text-muted-foreground">{{ t("workbench.system.network.routes") }}</h3>
          <table :class="TABLE.page.table" :aria-label="t('workbench.system.network.routes')">
            <tbody>
              <tr
                v-for="route in overview?.routes ?? []"
                :key="`${route.destination}-${route.device}`"
                :class="rowClass('page')"
              >
                <td :class="cn(TABLE.page.cell, 'w-40 font-mono text-[11px]')">{{ route.destination }}</td>
                <td :class="cn(TABLE.page.cell, 'font-mono text-[11px] text-muted-foreground')">
                  {{ route.gateway ?? t("workbench.system.network.direct") }}
                </td>
                <td :class="cn(TABLE.page.cell, 'w-24 font-mono text-[11px]')">{{ route.device }}</td>
              </tr>
              <tr v-if="(overview?.routes.length ?? 0) === 0">
                <td colspan="3" :class="TABLE.page.emptyCell">{{ t("workbench.system.network.noRoutes") }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div>
          <h3 class="mb-1 text-[11px] font-medium text-muted-foreground">{{ t("workbench.system.network.dns") }}</h3>
          <p class="font-mono text-[11px]">
            <span v-if="(overview?.dns.length ?? 0) === 0" class="text-muted-foreground">{{
              t("workbench.system.network.noDns")
            }}</span>
            <span v-for="server in overview?.dns ?? []" :key="server" class="mr-3">{{ server }}</span>
          </p>
        </div>
      </div>

      <!-- Journal: the tail the host keeps, growable by one ask at a time. -->
      <div v-else class="flex h-full flex-col">
        <div class="mb-1 flex items-center gap-2">
          <span class="text-[11px] text-muted-foreground">{{
            t("workbench.system.journal.tail", { count: journalLines })
          }}</span>
          <span class="flex-1" />
          <button
            type="button"
            class="rounded-md border border-border px-2 py-0.5 text-[11px] transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="journalLines >= 500"
            @click="moreJournal()"
          >
            {{ t("workbench.system.journal.more") }}
          </button>
        </div>
        <p v-if="journal && !journal.available" class="text-xs text-muted-foreground">
          {{ t("workbench.system.journal.unavailable") }}
        </p>
        <div v-else class="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-background/40 p-2">
          <p
            v-for="(line, index) in journal?.lines ?? []"
            :key="`${line.at}-${index}`"
            class="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed"
          >
            <span class="text-muted-foreground">{{ line.at }}</span>
            <span v-if="line.unit" class="ml-2 text-foreground/70">{{ line.unit }}</span>
            <span class="ml-2">{{ line.message }}</span>
          </p>
          <p v-if="(journal?.lines.length ?? 0) === 0" class="text-xs text-muted-foreground">
            {{ t("workbench.system.journal.empty") }}
          </p>
        </div>
      </div>
    </div>
    <ConfirmDialog
      :open="askingStop !== null"
      :title="t('workbench.system.serviceActions.stopTitle', { unit: askingStop?.unit ?? '' })"
      :message="t('workbench.system.serviceActions.stopMessage')"
      :confirm-label="t('workbench.system.serviceActions.stopConfirm')"
      danger
      @confirm="confirmStop()"
      @update:open="askingStop = null"
    />
  </section>
</template>
