<script setup lang="ts">
/**
 * The Docker window's volumes page: the engine's volumes, named, and the one way a person loses
 * one.
 *
 * The page is a reader, not a maker — there is no create here, because a volume a person makes
 * from a bare name is an empty volume that looks like progress. The columns are the readings the
 * engine's own listing gives: the driver a volume rides, where it is mounted on the engine's disk,
 * and its size when the daemon prints one at all — an engine that does not answer it gets a dash,
 * not a zero, which would read as "nothing stored".
 *
 * The removal's guardrail is the engine's own: a volume a container still mounts is refused by the
 * daemon, and the refusal reaches this page exactly as the daemon worded it, shown beside the
 * catalog's sentence so the original words are still there to be read.
 */
import { Ellipsis, LoaderCircle, RotateCw, X } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import WbEmpty from "@/components/ui/WbEmpty.vue";
import { useContextMenu } from "@/composables/useContextMenu";
import { describeShellError } from "@/i18n/errors";
import { backend } from "@/lib/backend/api";
import { asShellError, type ShellError } from "@/lib/backend/errors";
import type { MenuEntry } from "@/lib/menu/types";
import { TABLE, rowClass } from "@/lib/table";
import { cn } from "@/lib/utils";
import type { ContainerSession } from "@/stores/container";
import type { VolumeSummary } from "@/types/container";

const props = defineProps<{ session: ContainerSession }>();

const { t } = useI18n();
const { openMenu } = useContextMenu();

// -- the list -------------------------------------------------------------------

const volumes = ref<VolumeSummary[]>([]);
const loading = ref(false);
const failure = ref<ShellError | null>(null);
const text = ref("");

const rows = computed(() => {
  const needle = text.value.trim().toLowerCase();
  if (needle === "") {
    return [...volumes.value];
  }
  return volumes.value.filter((volume) => volume.name.toLowerCase().includes(needle));
});

function translate(key: string, params?: Record<string, string>): string {
  return params ? t(key, params) : t(key);
}

function describe(error: ShellError): string {
  return describeShellError(translate, error).message;
}

/**
 * Reads the list once. Called when the page mounts and when the refresh is pressed — and never
 * from a timer, because a volume does not appear by itself.
 */
async function load(): Promise<void> {
  const connectionId = props.session.connectionId;
  if (connectionId === null || loading.value) {
    return;
  }
  loading.value = true;
  try {
    const answer = await backend.dockerVolumes.list(connectionId);
    // A session that was replaced while the read was on its way does not get its answer.
    if (props.session.connectionId === connectionId) {
      volumes.value = answer;
      failure.value = null;
    }
  } catch (error) {
    if (props.session.connectionId === connectionId) {
      failure.value = asShellError(error, "volume_list");
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

const removing = ref<VolumeSummary | null>(null);
const removingBusy = ref(false);
/** The engine's own sentence for a refused removal, kept beside the catalog's rendering. */
const removeRefusal = ref<string | null>(null);

function openRowMenu(event: MouseEvent, volume: VolumeSummary): void {
  const entries: MenuEntry[] = [
    {
      kind: "action",
      id: "remove",
      labelKey: "container.desktop.volumes.remove",
      danger: true,
      run: () => {
        removing.value = volume;
        removeRefusal.value = null;
      },
    },
  ];
  openMenu(event, { key: "container.desktop.volumes.menu", params: { name: volume.name } }, entries);
}

async function removeVolume(): Promise<void> {
  const volume = removing.value;
  const connectionId = props.session.connectionId;
  if (!volume || connectionId === null || removingBusy.value) {
    return;
  }
  removingBusy.value = true;
  try {
    // The acknowledged flag is this confirm's answer. A volume a container still mounts is
    // refused by the engine before anything moves, and that refusal arrives as the daemon's own
    // sentence — kept here and drawn, because it names the container in the daemon's words.
    await backend.dockerVolumes.remove(connectionId, volume.name, true);
    removing.value = null;
    failure.value = null;
    void load();
  } catch (error) {
    const shellError = asShellError(error, "volume_remove");
    removeRefusal.value = shellError.detail ?? null;
    failure.value = shellError;
  } finally {
    removingBusy.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The page head: the page's name bold, the 300px search, no create — the page reads. -->
    <div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <h2 class="shrink-0 text-lg font-bold leading-none">{{ t("container.rail.volumes") }}</h2>
      <input
        v-model="text"
        type="text"
        spellcheck="false"
        class="h-7 w-[300px] rounded-sm border border-border bg-background px-2.5 text-xs focus:outline-none"
        :placeholder="t('container.desktop.volumes.search')"
        :aria-label="t('container.desktop.volumes.search')"
      />
      <div class="min-w-0 flex-1"></div>
      <button
        type="button"
        class="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--workbench-on-picture)_6%,transparent)] hover:text-foreground"
        :title="t('container.refresh')"
        :aria-label="t('container.refresh')"
        data-volumes-refresh
        @click="load()"
      >
        <RotateCw :size="12" />
      </button>
    </div>

    <!-- The page's own failures: the catalog's sentence, and the engine's own words beside it when
         there are any — the daemon's sentence names the container holding the volume. -->
    <div
      v-if="failure"
      role="alert"
      class="flex shrink-0 items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 select-text"
      data-volumes-failure
    >
      <span class="min-w-0 flex-1 text-[11px]">
        {{ describe(failure) }}
        <span
          v-if="removeRefusal"
          class="mt-0.5 block text-[10px] text-muted-foreground select-text"
          data-volumes-refusal
        >
          {{ removeRefusal }}
        </span>
      </span>
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
        v-if="loading && volumes.length === 0"
        class="flex items-center gap-1.5 px-1 py-3 text-[11px] text-muted-foreground"
        data-volumes-loading
      >
        <LoaderCircle :size="12" class="animate-spin" />
        {{ t("container.desktop.volumes.loading") }}
      </p>
      <table
        v-else
        :class="cn(TABLE.page.table, 'table-fixed')"
        :style="{ minWidth: '760px' }"
        :aria-label="t('container.rail.volumes')"
      >
        <thead :class="TABLE.page.head">
          <tr :class="TABLE.page.headRow">
            <th class="w-[22%]" :class="TABLE.page.headCell">{{ t("container.col.name") }}</th>
            <th class="w-[12%]" :class="TABLE.page.headCell">{{ t("container.desktop.volumes.driver") }}</th>
            <th class="w-[34%]" :class="TABLE.page.headCell">{{ t("container.desktop.volumes.mountpoint") }}</th>
            <th class="w-[14%]" :class="TABLE.page.headCell">{{ t("container.desktop.volumes.size") }}</th>
            <th class="w-[14%]" :class="TABLE.page.headCell">{{ t("container.desktop.volumes.createdAt") }}</th>
            <th class="w-[3rem]" :class="TABLE.page.headCell">{{ t("container.col.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="volume in rows"
            :key="volume.name"
            :class="cn(rowClass('page', { clickable: true, striped: true }))"
          >
            <td :class="TABLE.page.cell">
              <span class="block truncate font-mono text-[11px]" :title="volume.name" data-volumes-name>
                {{ volume.name }}
              </span>
            </td>
            <td :class="TABLE.page.cell">
              <span class="block truncate font-mono text-[11px]">{{ volume.driver }}</span>
            </td>
            <td :class="TABLE.page.cell">
              <span class="block truncate font-mono text-[11px]" :title="volume.mountpoint">
                {{ volume.mountpoint !== "" ? volume.mountpoint : "—" }}
              </span>
            </td>
            <td :class="TABLE.page.cell">
              <span class="nums block text-[11px]" data-volumes-size>
                {{ volume.size ? volume.size : "—" }}
              </span>
            </td>
            <td :class="TABLE.page.cell">
              <span class="nums block text-[11px]">
                {{ volume.createdAt ? volume.createdAt : "—" }}
              </span>
            </td>
            <td :class="TABLE.page.cell">
              <button
                type="button"
                class="grid size-5 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--workbench-on-picture)_6%,transparent)] hover:text-foreground"
                :title="t('container.desktop.volumes.menu', { name: volume.name })"
                :aria-label="t('container.desktop.volumes.menu', { name: volume.name })"
                @click="openRowMenu($event, volume)"
              >
                <Ellipsis :size="12" />
              </button>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td :colspan="6" :class="cn(TABLE.page.cell, TABLE.page.emptyCell)">
              <WbEmpty
                scenario="noData"
                size="sm"
                :description="
                  text.trim() === '' ? t('container.desktop.volumes.none') : t('container.desktop.volumes.noMatch')
                "
                class="mx-auto"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!--
      Removal keeps the workspace's gate: the confirmation carries the consequence, and a refusal
      comes back as the engine's own sentence on the strip above. No volume is removed behind this
      dialog, and none is made anywhere on this page.
    -->
    <ConfirmDialog
      :open="removing !== null"
      :title="t('container.desktop.volumes.removeTitle', { name: removing?.name ?? '' })"
      :message="t('container.desktop.volumes.removeMessage')"
      :confirm-label="t('container.desktop.volumes.removeVerb')"
      :loading="removingBusy"
      danger
      @confirm="removeVolume()"
      @update:open="removing = null"
    />
  </div>
</template>
