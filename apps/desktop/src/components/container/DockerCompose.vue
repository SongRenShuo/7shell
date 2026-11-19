<script setup lang="ts">
/**
 * The Docker window's Compose page: the projects the engine's plugin knows, and the verbs a
 * project takes.
 *
 * The rows fold what `compose ls` answers with the counts the labelled `ps` feeds in: a project's
 * services and containers, without opening anything. The verbs keep the workspace's gate —
 * restarting, bringing down and starting up are all asked about first, because each of them stops
 * running containers, and bringing down also removes them.
 *
 * The logs follow on the stream channel the container logs use, keyed by stream id the same way:
 * a line that arrives for a window that has moved on reaches nothing. The window itself is the
 * container log window's shape — a drawer beside the list, the buffer bounded, a pause that keeps
 * what arrives instead of dropping it.
 *
 * The list is read when the page opens and when the refresh is pressed, and at no other time. A
 * project is made by somebody's own hand here, and a page that refreshed itself would be guessing
 * at the engine's answer.
 */
import { Ellipsis, LoaderCircle, RotateCw, ScrollText, X } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import Select from "@/components/ui/Select.vue";
import Switch from "@/components/ui/Switch.vue";
import WbButton from "@/components/ui/WbButton.vue";
import WbEmpty from "@/components/ui/WbEmpty.vue";
import WbTag from "@/components/ui/WbTag.vue";
import { useContextMenu } from "@/composables/useContextMenu";
import { describeShellError } from "@/i18n/errors";
import { backend } from "@/lib/backend/api";
import { asShellError, type ShellError } from "@/lib/backend/errors";
import type { MenuEntry } from "@/lib/menu/types";
import { TABLE, rowClass } from "@/lib/table";
import { cn } from "@/lib/utils";
import { appendLogLine, splitLogLine, type ContainerSession } from "@/stores/container";
import type { ContainerTab } from "@/stores/terminals";
import type { ComposeProject } from "@/types/container";

import ContainerDialog from "./ContainerDialog.vue";
import {
  composeStatusTone,
  composeYmlPath,
  composeYmlProblem,
  filterComposeProjects,
  isValidComposeName,
  isValidYmlDirectory,
} from "./compose";

const props = defineProps<{ tab: ContainerTab; session: ContainerSession }>();

const { t } = useI18n();
const { openMenu } = useContextMenu();

// -- the list -------------------------------------------------------------------

const projects = ref<ComposeProject[]>([]);
const loading = ref(false);
const failure = ref<ShellError | null>(null);
const text = ref("");

const rows = computed(() => filterComposeProjects(projects.value, text.value));

function translate(key: string, params?: Record<string, string>): string {
  return params ? t(key, params) : t(key);
}

function describe(error: ShellError): string {
  return describeShellError(translate, error).message;
}

async function load(): Promise<void> {
  const connectionId = props.session.connectionId;
  if (connectionId === null || loading.value) {
    return;
  }
  loading.value = true;
  try {
    const answer = await backend.compose.list(connectionId);
    if (props.session.connectionId === connectionId) {
      projects.value = answer;
      failure.value = null;
    }
  } catch (error) {
    if (props.session.connectionId === connectionId) {
      failure.value = asShellError(error, "compose_ls");
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

// -- the row's menu and the three gated verbs -------------------------------------

const confirming = ref<{ kind: "restart" | "down" | "up"; project: ComposeProject } | null>(null);

/** The file an `up` reads: the engine's own answer, first path when the plugin lists several. */
function ymlPathOf(project: ComposeProject): string | null {
  const first = project.configFiles.split(",")[0]?.trim() ?? "";
  return first !== "" ? first : null;
}

function openRowMenu(event: MouseEvent, project: ComposeProject): void {
  const entries: MenuEntry[] = [
    {
      kind: "action",
      id: "logs",
      labelKey: "container.desktop.compose.logs",
      icon: ScrollText,
      run: () => {
        logsFor.value = project;
      },
    },
  ];
  // Starting up reads the file the plugin says the project was made from; without one on record
  // there is nothing to point the verb at, and a button that would fail is worse than no button.
  if (!project.status.toLowerCase().startsWith("running") && ymlPathOf(project) !== null) {
    entries.push({
      kind: "action",
      id: "up",
      labelKey: "container.desktop.compose.up",
      run: () => {
        confirming.value = { kind: "up", project };
      },
    });
  }
  entries.push(
    {
      kind: "action",
      id: "restart",
      labelKey: "container.desktop.compose.restart",
      run: () => {
        confirming.value = { kind: "restart", project };
      },
    },
    {
      kind: "action",
      id: "down",
      labelKey: "container.desktop.compose.down",
      danger: true,
      run: () => {
        confirming.value = { kind: "down", project };
      },
    },
  );
  openMenu(event, { key: "container.desktop.compose.menu", params: { name: project.name } }, entries);
}

async function confirmAction(): Promise<void> {
  const pending = confirming.value;
  confirming.value = null;
  const connectionId = props.session.connectionId;
  if (!pending || connectionId === null) {
    return;
  }
  const { kind, project } = pending;
  try {
    if (kind === "restart") {
      await backend.compose.restart(connectionId, project.name);
    } else if (kind === "down") {
      await backend.compose.down(connectionId, project.name);
    } else {
      const ymlPath = ymlPathOf(project);
      if (ymlPath !== null) {
        await backend.compose.up(connectionId, project.name, ymlPath, true);
      }
    }
    failure.value = null;
    void load();
  } catch (error) {
    failure.value = asShellError(error, `compose_${kind}`);
  }
}

const confirmTitle = computed(() => {
  const pending = confirming.value;
  if (!pending) {
    return "";
  }
  return t(
    pending.kind === "down"
      ? "container.desktop.compose.downTitle"
      : pending.kind === "restart"
        ? "container.desktop.compose.restartTitle"
        : "container.desktop.compose.upTitle",
    { name: pending.project.name },
  );
});

const confirmMessage = computed(() => {
  const pending = confirming.value;
  if (!pending) {
    return "";
  }
  switch (pending.kind) {
    case "down":
      return t("container.desktop.compose.downMessage");
    case "restart":
      return t("container.desktop.compose.restartMessage");
    case "up":
      return t("container.desktop.compose.upMessage", { name: pending.project.name });
  }
});

const confirmLabel = computed(() => {
  const pending = confirming.value;
  if (!pending) {
    return "";
  }
  return t(
    pending.kind === "down"
      ? "container.desktop.compose.down"
      : pending.kind === "restart"
        ? "container.desktop.compose.restart"
        : "container.desktop.compose.up",
  );
});

// -- the log window ---------------------------------------------------------------

const LOG_TAILS = [100, 500, 2000];
const logsFor = ref<ComposeProject | null>(null);
const tail = ref(500);
const wrap = ref(true);
const paused = ref(false);
const lines = ref<string[]>([]);
const backlog = ref<string[]>([]);
const logEnded = ref(false);
const body = ref<HTMLElement | null>(null);
const logFailure = ref<string | null>(null);
let streamId: string | null = null;
let logGeneration = 0;
let unlistenLine: (() => void) | null = null;
let unlistenEnd: (() => void) | null = null;

const tailOptions = computed(() => LOG_TAILS.map((count) => ({ value: String(count), label: String(count) })));

function scrollToEnd(): void {
  void Promise.resolve().then(() => {
    if (body.value) {
      body.value.scrollTop = body.value.scrollHeight;
    }
  });
}

function receive(line: string): void {
  if (paused.value) {
    appendLogLine(backlog.value, line);
    return;
  }
  appendLogLine(lines.value, line);
  scrollToEnd();
}

async function stopLogs(): Promise<void> {
  logGeneration += 1;
  const stream = streamId;
  streamId = null;
  if (stream !== null) {
    // The stream rides the container channel, so its stop is the container channel's stop.
    await backend.containers.streamStop(stream);
  }
}

/**
 * Follows one project's logs. The subscription is this page's own: the lines arrive on the
 * container stream channel, keyed by stream id, so a line for a window nobody watches anymore
 * reaches nothing.
 */
async function startLogs(): Promise<void> {
  await stopLogs();
  const project = logsFor.value;
  lines.value = [];
  backlog.value = [];
  logFailure.value = null;
  logEnded.value = false;
  if (!project) {
    return;
  }
  const connectionId = props.session.connectionId;
  if (connectionId === null) {
    return;
  }
  const generation = ++logGeneration;
  if (unlistenLine === null || unlistenEnd === null) {
    unlistenLine = await backend.containers.onStreamLine((payload) => {
      if (payload.streamId === streamId) {
        receive(payload.line);
      }
    });
    unlistenEnd = await backend.containers.onStreamEnd((payload) => {
      if (payload.streamId !== streamId) {
        return;
      }
      streamId = null;
      if (generation !== logGeneration) {
        return;
      }
      if (payload.error) {
        logFailure.value = payload.error;
      } else {
        logEnded.value = true;
      }
    });
  }
  try {
    const opened = await backend.compose.logsStart(connectionId, project.name, tail.value);
    if (generation !== logGeneration || !logsFor.value) {
      await backend.containers.streamStop(opened);
      return;
    }
    streamId = opened;
  } catch (error) {
    if (generation === logGeneration) {
      logFailure.value = describeShellError(translate, asShellError(error, "compose_logs")).message;
    }
  }
}

watch(logsFor, () => {
  void startLogs();
});

// A new tail is a new stream: the backend decides both when it starts.
watch(tail, () => {
  if (logsFor.value) {
    void startLogs();
  }
});

function togglePause(): void {
  if (paused.value) {
    const waiting = backlog.value;
    backlog.value = [];
    for (const line of waiting) {
      appendLogLine(lines.value, line);
    }
    paused.value = false;
    scrollToEnd();
    return;
  }
  paused.value = true;
}

function clearLogs(): void {
  lines.value = [];
  backlog.value = [];
}

// -- the create dialog ------------------------------------------------------------

const creatingOpen = ref(false);
const createName = ref("");
const createDirectory = ref("");
const createYml = ref("");
const startNow = ref(true);
const createBusy = ref(false);

function openCreate(): void {
  createName.value = "";
  createDirectory.value = "";
  createYml.value = "";
  startNow.value = true;
  createBusy.value = false;
  creatingOpen.value = true;
}

/** Said only when it is true: an untouched field is not an error. */
const nameProblem = computed(() =>
  createName.value.trim() === "" || isValidComposeName(createName.value.trim())
    ? null
    : t("container.desktop.compose.nameInvalid"),
);
const directoryProblem = computed(() =>
  createDirectory.value.trim() === "" || isValidYmlDirectory(createDirectory.value.trim())
    ? null
    : t("container.desktop.compose.dirInvalid"),
);
const ymlProblem = computed(() => {
  if (createYml.value.trim() === "") {
    return null;
  }
  const problem = composeYmlProblem(createYml.value);
  if (!problem) {
    return null;
  }
  return t(problem.kind === "tab" ? "container.desktop.compose.ymlTab" : "container.desktop.compose.ymlIndent", {
    line: String(problem.line),
  });
});
const createReady = computed(
  () =>
    createName.value.trim() !== "" &&
    createDirectory.value.trim() !== "" &&
    createYml.value.trim() !== "" &&
    nameProblem.value === null &&
    directoryProblem.value === null &&
    ymlProblem.value === null &&
    !createBusy.value,
);

async function submitCreate(): Promise<void> {
  const connectionId = props.session.connectionId;
  if (!createReady.value || connectionId === null) {
    return;
  }
  const name = createName.value.trim();
  const directory = createDirectory.value.trim();
  const yml = createYml.value;
  const ymlPath = composeYmlPath(directory);
  createBusy.value = true;
  try {
    // The file goes first, through the session's own file channel; the project starts from the
    // file on the engine's disk, detached — a start a person watches line by line is the logs
    // window's job, not the wizard's.
    await backend.compose.writeYaml(connectionId, ymlPath, yml);
    if (startNow.value) {
      await backend.compose.up(connectionId, name, ymlPath, true);
    }
    creatingOpen.value = false;
    failure.value = null;
    void load();
  } catch (error) {
    // The dialog stays open with the text in it: a refusal is read against what was refused.
    failure.value = asShellError(error, startNow.value ? "compose_up" : "compose_write_yaml");
  } finally {
    createBusy.value = false;
  }
}

onBeforeUnmount(() => {
  void stopLogs();
  unlistenLine?.();
  unlistenLine = null;
  unlistenEnd?.();
  unlistenEnd = null;
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The page head: the reference's own measure — the page's name bold, the 300px search, the
         primary action at the far end. -->
    <div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <h2 class="shrink-0 text-lg font-bold leading-none">{{ t("container.rail.compose") }}</h2>
      <input
        v-model="text"
        type="text"
        spellcheck="false"
        data-compose-filter
        class="h-7 w-[300px] rounded-sm border border-border bg-background px-2.5 text-xs focus:outline-none"
        :placeholder="t('container.desktop.compose.search')"
        :aria-label="t('container.desktop.compose.search')"
      />
      <div class="min-w-0 flex-1"></div>
      <WbButton variant="primary" data-compose-create @click="openCreate()">
        {{ t("container.desktop.compose.create") }}
      </WbButton>
      <button
        type="button"
        class="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--workbench-on-picture)_6%,transparent)] hover:text-foreground"
        :title="t('container.refresh')"
        :aria-label="t('container.refresh')"
        data-compose-refresh
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
      data-compose-failure
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
        v-if="loading && projects.length === 0"
        class="flex items-center gap-1.5 px-1 py-3 text-[11px] text-muted-foreground"
        data-compose-loading
      >
        <LoaderCircle :size="12" class="animate-spin" />
        {{ t("container.desktop.compose.loading") }}
      </p>
      <table
        v-else
        :class="cn(TABLE.page.table, 'table-fixed')"
        :style="{ minWidth: '680px' }"
        :aria-label="t('container.rail.compose')"
      >
        <thead :class="TABLE.page.head">
          <tr :class="TABLE.page.headRow">
            <th class="w-[34%]" :class="TABLE.page.headCell">{{ t("container.col.name") }}</th>
            <th class="w-[22%]" :class="TABLE.page.headCell">{{ t("container.col.state") }}</th>
            <th class="w-[14%]" :class="TABLE.page.headCell">{{ t("container.desktop.compose.services") }}</th>
            <th class="w-[22%]" :class="TABLE.page.headCell">{{ t("container.desktop.compose.containers") }}</th>
            <th class="w-[3rem]" :class="TABLE.page.headCell">{{ t("container.col.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="project in rows"
            :key="project.name"
            :class="cn(rowClass('page', { clickable: true, striped: true }))"
          >
            <td :class="TABLE.page.cell">
              <span class="block truncate font-mono text-[11px]" :title="project.name">{{ project.name }}</span>
            </td>
            <td :class="TABLE.page.cell">
              <WbTag :tone="composeStatusTone(project.status)" data-compose-status>
                {{ project.status !== "" ? project.status : "—" }}
              </WbTag>
            </td>
            <td :class="TABLE.page.cell">
              <span class="block font-mono text-[11px]" data-compose-services>{{ project.services }}</span>
            </td>
            <td :class="TABLE.page.cell">
              <span class="block font-mono text-[11px]" data-compose-containers>{{ project.containers }}</span>
            </td>
            <td :class="TABLE.page.cell">
              <button
                type="button"
                class="grid size-5 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--workbench-on-picture)_6%,transparent)] hover:text-foreground"
                :title="t('container.desktop.compose.menu', { name: project.name })"
                :aria-label="t('container.desktop.compose.menu', { name: project.name })"
                @click="openRowMenu($event, project)"
              >
                <Ellipsis :size="12" />
              </button>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td :colspan="5" :class="cn(TABLE.page.cell, TABLE.page.emptyCell)">
              <WbEmpty
                scenario="noData"
                size="sm"
                :description="
                  text.trim() === '' ? t('container.desktop.compose.none') : t('container.desktop.compose.noMatch')
                "
                class="mx-auto"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!--
      The project's log window: the container log window's shape, on the stream channel the two
      share. The tail is the plugin's own reading; a pause keeps what arrives rather than losing it.
    -->
    <div v-if="logsFor" class="absolute inset-0 z-20" @click.self="logsFor = null">
      <div
        class="absolute inset-y-0 right-0 flex w-[min(40rem,100%)] flex-col border-l border-border bg-card shadow-xl"
        role="dialog"
        :aria-label="t('container.desktop.compose.logsTitle', { name: logsFor.name })"
      >
        <header class="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span class="min-w-0 truncate text-xs font-medium">
            {{ t("container.desktop.compose.logsTitle", { name: logsFor.name }) }}
          </span>
          <button
            type="button"
            class="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            :title="t('common.action.close')"
            :aria-label="t('common.action.close')"
            @click="logsFor = null"
          >
            <X :size="12" />
          </button>
        </header>

        <div class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2.5 py-1.5">
          <Select
            :model-value="String(tail)"
            :options="tailOptions"
            size="compact"
            class="w-16"
            :aria-label="t('container.logs.tail')"
            @update:model-value="tail = Number($event)"
          />
          <button
            type="button"
            class="flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] transition-colors"
            :class="
              wrap ? 'border-primary/50 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'
            "
            :aria-pressed="wrap"
            @click="wrap = !wrap"
          >
            {{ t("container.logs.wrap") }}
          </button>
          <button
            type="button"
            class="rounded-sm border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            data-compose-logs-pause
            @click="togglePause()"
          >
            {{ paused ? t("container.logs.resume") : t("container.logs.pause") }}
          </button>
          <button
            type="button"
            class="rounded-sm border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            @click="clearLogs()"
          >
            {{ t("container.logs.clear") }}
          </button>
          <span v-if="paused" class="text-[10px] text-muted-foreground">{{ t("container.logs.paused") }}</span>
        </div>

        <p
          v-if="logFailure"
          class="shrink-0 border-b border-destructive/40 bg-destructive/10 px-2.5 py-1 text-[11px] text-destructive select-text"
        >
          {{ logFailure }}
        </p>

        <div
          ref="body"
          class="min-h-0 flex-1 overflow-auto px-2.5 py-2 font-mono text-[11px] select-text"
          :class="wrap ? '' : 'overflow-x-auto'"
        >
          <p v-if="lines.length === 0" class="text-[11px] text-muted-foreground">{{ t("container.logs.empty") }}</p>
          <div
            v-for="(line, index) in lines"
            :key="index"
            :class="wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'"
          >
            <span v-if="splitLogLine(line).timestamp" class="mr-1.5 text-muted-foreground">{{
              splitLogLine(line).timestamp
            }}</span>
            <span>{{ splitLogLine(line).message }}</span>
          </div>
          <p v-if="logEnded" class="mt-1 text-[10px] text-muted-foreground">{{ t("container.logs.ended") }}</p>
        </div>
      </div>
    </div>

    <!--
      A new project: a name the engine uses exactly as typed, a directory for the file to live in,
      and the file itself — checked for the two mistakes a text area can see while it is typed.
      Starting right away is the one promise the wizard keeps by hand.
    -->
    <ContainerDialog
      :open="creatingOpen"
      :title="t('container.desktop.compose.createTitle')"
      :busy="createBusy"
      @update:open="creatingOpen = $event"
    >
      <label class="flex flex-col gap-1">
        <span class="text-[11px] text-muted-foreground">{{ t("container.desktop.compose.nameLabel") }}</span>
        <input
          v-model="createName"
          type="text"
          spellcheck="false"
          data-compose-name
          class="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
          :class="nameProblem ? 'border-destructive' : ''"
          :placeholder="t('container.desktop.compose.namePlaceholder')"
          :aria-label="t('container.desktop.compose.nameLabel')"
        />
        <span v-if="nameProblem" class="text-[10px] text-destructive">{{ nameProblem }}</span>
        <span v-else class="text-[10px] text-muted-foreground">{{ t("container.desktop.compose.nameHint") }}</span>
      </label>

      <label class="mt-2 flex flex-col gap-1">
        <span class="text-[11px] text-muted-foreground">{{ t("container.desktop.compose.dirLabel") }}</span>
        <input
          v-model="createDirectory"
          type="text"
          spellcheck="false"
          data-compose-directory
          class="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
          :class="directoryProblem ? 'border-destructive' : ''"
          :placeholder="t('container.desktop.compose.dirPlaceholder')"
          :aria-label="t('container.desktop.compose.dirLabel')"
        />
        <span v-if="directoryProblem" class="text-[10px] text-destructive">{{ directoryProblem }}</span>
        <span v-else class="text-[10px] text-muted-foreground">{{ t("container.desktop.compose.dirHint") }}</span>
      </label>

      <label class="mt-2 flex flex-col gap-1">
        <span class="text-[11px] text-muted-foreground">docker-compose.yml</span>
        <textarea
          v-model="createYml"
          spellcheck="false"
          rows="10"
          data-compose-yml
          class="w-full resize-y rounded-md border border-border bg-background px-2 py-1 font-mono text-xs leading-relaxed focus:outline-none"
          :class="ymlProblem ? 'border-destructive' : ''"
          :placeholder="t('container.desktop.compose.ymlPlaceholder')"
          aria-label="docker-compose.yml"
        ></textarea>
        <span v-if="ymlProblem" class="text-[10px] text-destructive">{{ ymlProblem }}</span>
        <span v-else class="text-[10px] text-muted-foreground">{{ t("container.desktop.compose.ymlHint") }}</span>
      </label>

      <div class="mt-2 flex items-center justify-between gap-2">
        <span class="min-w-0">
          <span class="block text-[11px]">{{ t("container.desktop.compose.startNow") }}</span>
          <span class="block text-[10px] text-muted-foreground">{{ t("container.desktop.compose.startNowHint") }}</span>
        </span>
        <Switch v-model="startNow" :aria-label="t('container.desktop.compose.startNow')" data-compose-start-now />
      </div>

      <template #footer>
        <WbButton :disabled="createBusy" @click="creatingOpen = false">{{ t("common.action.cancel") }}</WbButton>
        <WbButton
          variant="primary"
          :busy="createBusy"
          :disabled="!createReady"
          data-compose-submit
          @click="submitCreate()"
        >
          {{ createBusy ? t("container.desktop.compose.creating") : t("container.desktop.compose.submit") }}
        </WbButton>
      </template>
    </ContainerDialog>

    <!--
      The three verbs keep the workspace's gate: the confirmation carries the consequence — for a
      project brought down, that its containers stop and are removed.
    -->
    <ConfirmDialog
      :open="confirming !== null"
      :title="confirmTitle"
      :message="confirmMessage"
      :confirm-label="confirmLabel"
      :danger="confirming?.kind === 'down'"
      @confirm="confirmAction()"
      @update:open="confirming = null"
    />
  </div>
</template>
