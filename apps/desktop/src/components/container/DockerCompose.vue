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
 * what arrives instead of dropping it. A project's lines are filtered by the service that wrote
 * them, read out of the `name | message` prefix the plugin's logs carry, and the prefix wears a
 * colour per service so a project's services tell themselves apart at a glance.
 *
 * The list is read when the page opens and when the refresh is pressed, and at no other time. A
 * project is made by somebody's own hand here, and a page that refreshed itself would be guessing
 * at the engine's answer.
 *
 * A project's own file can be edited and taken away: the editor reads the Compose file through the
 * session's file channel, shows the save as a line diff before anything is written, and the apply
 * is a rebuild — `up -d` on the file as saved — behind the confirmation that says what a rebuild
 * ends. The export hands out the same file as a download named for its project. The rail's Compose
 * badge counts the running projects; this page reads the list, so the count is handed up from
 * here.
 *
 * The table's columns follow the workspace's column rule: the name, the state and the actions are
 * the floor, the two folded counts hide by choice or by a narrow window, and the choices live in
 * localStorage (see `listColumns.ts`).
 */
import { Columns3, Ellipsis, FileDown, FilePen, LoaderCircle, RotateCw, ScrollText, X } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { countDiffChanges, diffYaml, yamlUnchanged, type YamlDiffRow } from "@/components/container/composeEdit";
import { composeLogService, logSourceColor, splitComposePrefix } from "@/components/container/logSource";
import { composeExportFileName } from "@/components/container/composeRun";
import {
  isColumnShown,
  readColumnChoices,
  shownColumnCount,
  useNarrowViewport,
  writeColumnChoices,
  type ColumnChoices,
} from "@/components/container/listColumns";
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
  composeRunningCount,
  composeStatusTone,
  composeYmlPath,
  composeYmlProblem,
  filterComposeProjects,
  isValidComposeName,
  isValidYmlDirectory,
} from "./compose";

const props = defineProps<{ tab: ContainerTab; session: ContainerSession }>();

/** How many running projects the rail's Compose badge carries, handed up as the list reads. */
const emit = defineEmits<{ "running-count": [count: number | null] }>();

const { t } = useI18n();
const { openMenu } = useContextMenu();

// -- the list -------------------------------------------------------------------

const projects = ref<ComposeProject[]>([]);
const loading = ref(false);
const failure = ref<ShellError | null>(null);
/**
 * The one refusal the interface itself knows — a file channel that stood behind a host-key
 * decision nobody on this page can answer — kept apart from the engine's own failures, which
 * travel in envelopes this page describes.
 */
const fileChannelRefusal = ref<string | null>(null);
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
      emit("running-count", composeRunningCount(answer));
    }
  } catch (error) {
    if (props.session.connectionId === connectionId) {
      failure.value = asShellError(error, "compose_ls");
      emit("running-count", null);
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
function ymlPathOf(project: ComposeProject | null): string | null {
  const first = project?.configFiles?.split(",")[0]?.trim() ?? "";
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
  // Editing and exporting read the file the plugin says the project was made from; without one on
  // record there is nothing to point either verb at, and a button that would fail is worse than no
  // button. Both keep the workspace's gate: the editor's apply confirms the rebuild it starts.
  if (ymlPathOf(project) !== null) {
    entries.push(
      {
        kind: "action",
        id: "edit",
        labelKey: "container.desktop.compose.edit",
        icon: FilePen,
        run: () => {
          void openEditor(project);
        },
      },
      {
        kind: "action",
        id: "export",
        labelKey: "container.desktop.compose.export",
        icon: FileDown,
        disabled: exportingFor.value !== null,
        run: () => {
          void exportProject(project);
        },
      },
    );
  }
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

// -- the columns the table draws ---------------------------------------------------

/**
 * The project table's columns, and who decides which of them it keeps. The name, the state and the
 * actions are the floor — the list is read by them — while the two folded counts are the columns a
 * narrow window trims first (see `listColumns.ts` for the whole rule).
 */
const COMPOSE_COLUMNS = [
  { id: "name", primary: true },
  { id: "state", primary: true },
  { id: "services", primary: false },
  { id: "containers", primary: false },
  { id: "actions", primary: true },
] as const;

const narrow = useNarrowViewport();
const columnChoices = ref<ColumnChoices>(readColumnChoices("compose"));

function columnShown(id: string): boolean {
  const column = COMPOSE_COLUMNS.find((entry) => entry.id === id);
  return column !== undefined && isColumnShown(column, columnChoices.value, narrow.value);
}

const columnSpan = computed(() => shownColumnCount(COMPOSE_COLUMNS, columnChoices.value, narrow.value));

/** The words the column menus name the secondary columns by. */
const COLUMN_LABEL_KEYS: Readonly<Record<string, string>> = {
  services: "container.desktop.compose.services",
  containers: "container.desktop.compose.containers",
};

function columnLabel(id: string): string {
  return t(COLUMN_LABEL_KEYS[id] ?? `container.col.${id}`);
}

/** One column's menu: hide the column it opened from, and the way back for everything trimmed. */
function openColumnsMenu(event: MouseEvent, hideId?: string): void {
  const entries: MenuEntry[] = [];
  if (hideId !== undefined) {
    entries.push({
      kind: "action",
      id: `column-hide-${hideId}`,
      labelKey: "container.columns.hideColumn",
      params: { column: columnLabel(hideId) },
      run: () => setColumn(hideId, "hidden"),
    });
    entries.push({ kind: "separator", id: "column-separator" });
  }
  for (const column of COMPOSE_COLUMNS) {
    if (column.primary) {
      continue;
    }
    entries.push({
      kind: "action",
      id: `column-${column.id}`,
      labelKey: COLUMN_LABEL_KEYS[column.id] ?? `container.col.${column.id}`,
      checked: isColumnShown(column, columnChoices.value, narrow.value),
      run: () => setColumn(column.id, columnShown(column.id) ? "hidden" : "shown"),
    });
  }
  openMenu(event, { key: "container.columns.menu" }, entries);
}

function setColumn(id: string, choice: "shown" | "hidden"): void {
  columnChoices.value = { ...columnChoices.value, [id]: choice };
  writeColumnChoices("compose", columnChoices.value);
}

// -- the project's YAML editor -----------------------------------------------------

const editing = ref<ComposeProject | null>(null);
const editOpen = ref(false);
const editOriginal = ref("");
const editText = ref("");
const editLoading = ref(false);
const editBusy = ref(false);
const editFailure = ref<string | null>(null);
const rebuildConfirming = ref(false);
const rebuildAck = ref(false);
const rebuildRefused = ref(false);

const editProblem = computed(() => {
  const problem = composeYmlProblem(editText.value);
  if (!problem) {
    return null;
  }
  return t(problem.kind === "tab" ? "container.desktop.compose.ymlTab" : "container.desktop.compose.ymlIndent", {
    line: String(problem.line),
  });
});

const editRows = computed<YamlDiffRow[]>(() => diffYaml(editOriginal.value, editText.value));
const editChanges = computed(() => countDiffChanges(editRows.value));
const editChanged = computed(() => !yamlUnchanged(editOriginal.value, editText.value));
/** The preview is capped: a pathological paste draws its first four hundred rows, not all of it. */
const editShownRows = computed(() => editRows.value.slice(0, MAX_DIFF_ROWS));

const MAX_DIFF_ROWS = 400;

/**
 * Reads one project's Compose file through the session's file channel, opened and closed for the
 * one read — the same carriers the write verb uses on its own. A host-key decision standing in
 * front of the channel arrives as an outcome, not an error, and there is nobody on this page to
 * ask: the refusal is the answer.
 */
async function readProjectYaml(project: ComposeProject): Promise<string> {
  const path = ymlPathOf(project);
  if (path === null) {
    throw new Error("no compose file on record");
  }
  const outcome = await backend.files.open(props.tab.session.id);
  if (outcome.kind !== "opened") {
    throw new ChannelRefused();
  }
  try {
    return await backend.files.readText(outcome.handle, path);
  } finally {
    await backend.files.close(outcome.handle);
  }
}

/** The files channel stood in front of the read with a question nobody on this page can answer. */
class ChannelRefused extends Error {}

async function openEditor(project: ComposeProject): Promise<void> {
  editing.value = project;
  editOriginal.value = "";
  editText.value = "";
  editFailure.value = null;
  editLoading.value = true;
  editBusy.value = false;
  rebuildConfirming.value = false;
  rebuildAck.value = false;
  rebuildRefused.value = false;
  editOpen.value = true;
  try {
    const yml = await readProjectYaml(project);
    editOriginal.value = yml;
    editText.value = yml;
  } catch (error) {
    editFailure.value =
      error instanceof ChannelRefused
        ? t("container.desktop.compose.editReadRefused")
        : describe(asShellError(error, "files_read_text"));
  } finally {
    editLoading.value = false;
  }
}

/** Writes the edited text to the project's file, and — when applying — brings the file up. */
async function writeProjectYaml(project: ComposeProject, apply: boolean): Promise<void> {
  const connectionId = props.session.connectionId;
  const path = ymlPathOf(project);
  if (connectionId === null || path === null || editBusy.value) {
    return;
  }
  editBusy.value = true;
  editFailure.value = null;
  try {
    await backend.compose.writeYaml(connectionId, path, editText.value);
    if (apply) {
      await backend.compose.up(connectionId, project.name, path, true);
    }
    editOpen.value = false;
    editing.value = null;
    failure.value = null;
    void load();
  } catch (error) {
    editFailure.value = describe(asShellError(error, apply ? "compose_up" : "compose_write_yaml"));
  } finally {
    editBusy.value = false;
  }
}

/** The one question before the file is applied: what a rebuild ends, and the answer that lets it. */
function requestApply(): void {
  if (!editChanged.value || editProblem.value !== null || editBusy.value) {
    return;
  }
  rebuildAck.value = false;
  rebuildRefused.value = false;
  rebuildConfirming.value = true;
}

async function confirmRebuild(): Promise<void> {
  const project = editing.value;
  if (project === null) {
    rebuildConfirming.value = false;
    return;
  }
  // The checkbox is the acknowledgment the rebuild travels on; a confirm that arrives without it
  // is not an answer yet, and the dialog stays up to take one.
  if (!rebuildAck.value) {
    rebuildRefused.value = true;
    return;
  }
  rebuildConfirming.value = false;
  await writeProjectYaml(project, true);
}

async function saveOnly(): Promise<void> {
  const project = editing.value;
  if (project === null || !editChanged.value || editProblem.value !== null || editBusy.value) {
    return;
  }
  await writeProjectYaml(project, false);
}

// -- the orchestration export --------------------------------------------------------

/** The one export in flight, named by its project so a second row's verb can wait. */
const exportingFor = ref<string | null>(null);

function downloadTextFile(name: string, text: string): void {
  const blob = new Blob([text], { type: "application/x-yaml" });
  const address = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = address;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(address);
}

/**
 * Hands one project's Compose file to the person as a download: the file as the engine's host
 * holds it, named for the project it came from. The read is the editor's read; nothing here
 * writes to the engine or restarts anything.
 */
async function exportProject(project: ComposeProject): Promise<void> {
  if (exportingFor.value !== null) {
    return;
  }
  exportingFor.value = project.name;
  try {
    const yml = await readProjectYaml(project);
    downloadTextFile(composeExportFileName(project.name), yml);
    failure.value = null;
    fileChannelRefusal.value = null;
  } catch (error) {
    if (error instanceof ChannelRefused) {
      fileChannelRefusal.value = t("container.desktop.compose.exportRefused");
    } else {
      failure.value = asShellError(error, "files_read_text");
    }
  } finally {
    exportingFor.value = null;
  }
}

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
  // A filter names one project's service; another project's window starts with every service.
  serviceFilter.value = "";
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

// -- the service filter ---------------------------------------------------------

/** The service the window narrows to; `""` is "every service", not a filter. */
const serviceFilter = ref("");

/**
 * The services the buffer has heard from, in the order the filter lists them.
 *
 * The list is read from the whole buffer rather than the drawn lines, so narrowing to one service
 * does not take the others out of the dropdown — the way back is always on it.
 */
const serviceOptions = computed(() => {
  const names = new Set<string>();
  const project = logsFor.value?.name ?? "";
  for (const line of lines.value) {
    const service = composeLogService(line, project);
    if (service !== "") {
      names.add(service);
    }
  }
  return [
    { value: "", label: t("container.logs.allServices") },
    ...[...names].sort().map((name) => ({ value: name, label: name })),
  ];
});

/** The lines the window draws: everything, or only the service the filter names. */
const shownLines = computed(() => {
  if (serviceFilter.value === "") {
    return lines.value;
  }
  const project = logsFor.value?.name ?? "";
  return lines.value.filter((line) => composeLogService(line, project) === serviceFilter.value);
});

/** The colour a service's prefix wears, keyed by its place in the filter's order. */
function colorOfService(service: string): string {
  // The filter's first entry is "every service", not a colour of its own.
  const at = serviceOptions.value.findIndex((option) => option.value === service);
  return logSourceColor(Math.max(0, at - 1));
}

/** A drawn line's pieces, cut once: the runtime's timestamp, the prefix, and the message. */
interface ComposeLineParts {
  readonly timestamp: string;
  readonly prefix: string | null;
  readonly message: string;
  readonly color: string;
}

const shownParts = computed<ComposeLineParts[]>(() => {
  const project = logsFor.value?.name ?? "";
  return shownLines.value.map((line) => {
    const { timestamp, message } = splitLogLine(line);
    const split = splitComposePrefix(message);
    if (split === null) {
      return { timestamp, prefix: null, message, color: "" };
    }
    return {
      timestamp,
      prefix: split.prefix,
      message: split.message,
      color: colorOfService(composeLogService(line, project)),
    };
  });
});

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
        :title="t('container.columns.toolbar')"
        :aria-label="t('container.columns.toolbar')"
        data-compose-columns
        @click="openColumnsMenu($event)"
      >
        <Columns3 :size="12" />
      </button>
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
      v-if="failure || fileChannelRefusal"
      role="alert"
      class="flex shrink-0 items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 select-text"
      data-compose-failure
    >
      <span class="min-w-0 flex-1 text-[11px]">
        {{ failure ? describe(failure) : fileChannelRefusal }}
      </span>
      <button
        type="button"
        class="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        :title="t('container.dismiss')"
        :aria-label="t('container.dismiss')"
        @click="
          failure = null;
          fileChannelRefusal = null;
        "
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
            <th class="w-[14%]" :class="TABLE.page.headCell">
              <span class="flex items-center gap-0.5">
                {{ t("container.desktop.compose.services") }}
                <button
                  type="button"
                  class="grid size-4 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  :title="t('container.columns.menu')"
                  :aria-label="t('container.columns.menu')"
                  data-compose-column-services
                  @click="openColumnsMenu($event, 'services')"
                >
                  <Columns3 :size="10" />
                </button>
              </span>
            </th>
            <th class="w-[22%]" :class="TABLE.page.headCell">
              <span class="flex items-center gap-0.5">
                {{ t("container.desktop.compose.containers") }}
                <button
                  type="button"
                  class="grid size-4 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  :title="t('container.columns.menu')"
                  :aria-label="t('container.columns.menu')"
                  data-compose-column-containers
                  @click="openColumnsMenu($event, 'containers')"
                >
                  <Columns3 :size="10" />
                </button>
              </span>
            </th>
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
            <td v-if="columnShown('services')" :class="TABLE.page.cell">
              <span class="block font-mono text-[11px]" data-compose-services>{{ project.services }}</span>
            </td>
            <td v-if="columnShown('containers')" :class="TABLE.page.cell">
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
            <td :colspan="columnSpan" :class="cn(TABLE.page.cell, TABLE.page.emptyCell)">
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
          <Select
            :model-value="serviceFilter"
            :options="serviceOptions"
            size="compact"
            class="w-36"
            :aria-label="t('container.logs.serviceFilter')"
            data-compose-logs-service
            @update:model-value="serviceFilter = $event"
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
          <p v-if="lines.length === 0 && serviceFilter === ''" class="text-[11px] text-muted-foreground">
            {{ t("container.logs.empty") }}
          </p>
          <p
            v-else-if="shownLines.length === 0"
            class="text-[11px] text-muted-foreground"
            data-compose-logs-service-empty
          >
            {{ t("container.logs.serviceEmpty") }}
          </p>
          <div
            v-for="(parts, index) in shownParts"
            :key="index"
            :class="wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'"
          >
            <span v-if="parts.timestamp !== ''" class="mr-1.5 text-muted-foreground">{{ parts.timestamp }}</span>
            <template v-if="parts.prefix !== null">
              <span
                class="mr-1.5 font-medium"
                :style="{ color: parts.color }"
                :data-compose-logs-prefix="parts.prefix"
                >{{ parts.prefix }}</span
              >
              <span class="mr-1.5 text-muted-foreground">|</span>
              <span>{{ parts.message }}</span>
            </template>
            <span v-else>{{ parts.message }}</span>
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
      The project's YAML editor: the file as the engine's host holds it, a diff of what the save
      will change, and the two ways out — a write that touches nothing that runs, and an apply that
      is a rebuild, behind the gate that says what the rebuild ends.
    -->
    <ContainerDialog
      :open="editOpen"
      :title="t('container.desktop.compose.editTitle', { name: editing?.name ?? '' })"
      :busy="editBusy || editLoading"
      @update:open="editOpen = $event"
    >
      <p
        v-if="editLoading"
        class="flex items-center gap-1.5 text-[11px] text-muted-foreground"
        data-compose-edit-loading
      >
        <LoaderCircle :size="12" class="animate-spin" />
        {{ t("container.desktop.compose.editLoading") }}
      </p>
      <template v-else>
        <p
          v-if="editFailure"
          role="alert"
          class="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive select-text"
          data-compose-edit-failure
        >
          {{ editFailure }}
        </p>
        <label class="mt-1 flex flex-col gap-1">
          <span class="text-[11px] text-muted-foreground">docker-compose.yml</span>
          <textarea
            v-model="editText"
            spellcheck="false"
            rows="12"
            data-compose-edit-yml
            class="w-full resize-y rounded-md border border-border bg-background px-2 py-1 font-mono text-xs leading-relaxed focus:outline-none"
            :class="editProblem ? 'border-destructive' : ''"
            aria-label="docker-compose.yml"
          ></textarea>
          <span v-if="editProblem" class="text-[10px] text-destructive">{{ editProblem }}</span>
          <span v-else class="text-[10px] text-muted-foreground">{{ t("container.desktop.compose.editHint") }}</span>
        </label>

        <!-- The save, seen before it is made: what the file loses and what it gains. -->
        <div v-if="editChanged" class="mt-2" data-compose-edit-diff>
          <p class="text-[11px] text-muted-foreground">
            {{
              t("container.desktop.compose.diffTitle", {
                added: String(editChanges.added),
                removed: String(editChanges.removed),
              })
            }}
          </p>
          <div
            class="mt-1 max-h-40 overflow-y-auto rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-[11px]"
          >
            <div
              v-for="(row, index) in editShownRows"
              :key="index"
              class="whitespace-pre-wrap break-all"
              :class="
                row.kind === 'added'
                  ? 'text-success'
                  : row.kind === 'removed'
                    ? 'text-destructive'
                    : 'text-muted-foreground'
              "
            >
              <span class="mr-1 select-none">{{ row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " " }}</span
              >{{ row.text }}
            </div>
            <p v-if="editRows.length > editShownRows.length" class="text-[10px] text-muted-foreground">
              {{ t("container.desktop.compose.diffCropped") }}
            </p>
          </div>
        </div>
        <p v-else class="mt-2 text-[11px] text-muted-foreground" data-compose-edit-unchanged>
          {{ t("container.desktop.compose.editUnchanged") }}
        </p>
      </template>

      <template #footer>
        <WbButton :disabled="editBusy" @click="editOpen = false">{{ t("common.action.cancel") }}</WbButton>
        <WbButton
          :busy="editBusy"
          :disabled="!editChanged || editProblem !== null"
          data-compose-edit-save
          @click="saveOnly()"
        >
          {{ t("container.desktop.compose.saveOnly") }}
        </WbButton>
        <WbButton
          variant="primary"
          :busy="editBusy"
          :disabled="!editChanged || editProblem !== null"
          data-compose-edit-apply
          @click="requestApply()"
        >
          {{ t("container.desktop.compose.saveApply") }}
        </WbButton>
      </template>
    </ContainerDialog>

    <!--
      The rebuild's gate: applying is a rebuild — a container whose configuration changed stops and
      starts again. The checkbox is the acknowledgment the answer travels on; the dialog stays up
      until it is given.
    -->
    <ConfirmDialog
      :open="rebuildConfirming"
      :title="t('container.desktop.compose.rebuildTitle', { name: editing?.name ?? '' })"
      :message="t('container.desktop.compose.rebuildMessage', { path: ymlPathOf(editing) ?? '' })"
      :confirm-label="t('container.desktop.compose.saveApply')"
      @confirm="confirmRebuild()"
      @update:open="rebuildConfirming = false"
    >
      <label class="mt-3 flex items-center gap-2 text-[11px]" data-compose-rebuild-ack>
        <input v-model="rebuildAck" type="checkbox" class="size-3 accent-[var(--primary)]" />
        {{ t("container.desktop.compose.rebuildAck") }}
      </label>
      <p v-if="rebuildRefused" class="mt-1 text-[10px] text-destructive" data-compose-rebuild-refused>
        {{ t("container.desktop.compose.rebuildAckRequired") }}
      </p>
    </ConfirmDialog>

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
