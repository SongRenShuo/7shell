<script setup lang="ts">
/**
 * One container in full, and its logs.
 *
 * Two modes rather than two components: the logs and the detail are the same container, opened from
 * the same row, and a person moves between them without losing which container they are about.
 *
 * The log view follows the tail. The buffer is bounded — a container that logs a line a millisecond
 * would otherwise grow the window's memory without limit — and pausing does not stop reading: lines
 * that arrive while it is paused are kept aside and appear when it is resumed, because a pause that
 * silently discarded output would be a pause that lost the reason somebody paused.
 */
import { LoaderCircle, RotateCw, WrapText, X } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Select from "@/components/ui/Select.vue";
import { describeShellError } from "@/i18n/errors";
import { asShellError } from "@/lib/backend/errors";
import { appendLogLine, splitLogLine, useContainerStore } from "@/stores/container";
import type { ContainerDetail, ContainerSummary } from "@/types/container";

const props = defineProps<{
  mode: "detail" | "logs" | null;
  tabId: string;
  target: ContainerSummary | null;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const containers = useContainerStore();

const tab = ref<"detail" | "json">("detail");
const detail = ref<ContainerDetail | null>(null);
const detailFailure = ref<string | null>(null);
const detailLoading = ref(false);
const copied = ref(false);
let detailGeneration = 0;
let copyTimer: number | undefined;

function translate(key: string, params?: Record<string, string>): string {
  return params ? t(key, params) : t(key);
}

const title = computed(() => {
  if (!props.target) {
    return "";
  }
  return props.mode === "logs"
    ? t("container.logs.title", { name: props.target.name })
    : t("container.detail.title", { name: props.target.name });
});

// -- detail --------------------------------------------------------------------

interface DetailSection {
  label: string;
  fields: [string, string][];
}

/**
 * The error words the "errors only" switch reads a line for.
 *
 * `docker logs` hands stdout and stderr down one pipe, so a real split needs two streams and a
 * contract change; until the engine grows a stream tag this is the honest approximation the
 * reference manager's errLog gives — a line that says it went wrong. The words are matched
 * case-insensitively anywhere in the line, the way a person scanning a log would.
 */
const ERROR_PATTERN = /\b(error|err!|fatal|panic|exception|failed|failure|refused|denied|timeout|timed out)\b/i;

/** Whether the view shows only the lines that read as errors. */
const errorsOnly = ref(false);

/** The lines the view draws: everything, or only what reads as an error. */
const shownLines = computed(() => {
  if (!errorsOnly.value) {
    return lines.value;
  }
  return lines.value.filter((line) => ERROR_PATTERN.test(splitLogLine(line).message));
});

/** The labels a container's raw inspect document carries, as `k=v` lines. */
function labelsOf(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { Config?: { Labels?: Record<string, unknown> } };
    return Object.entries(parsed.Config?.Labels ?? {})
      .map(([name, value]) => `${name}=${String(value)}`)
      .join("\n");
  } catch {
    return "";
  }
}

const detailSections = computed<DetailSection[]>(() => {
  const current = detail.value;
  if (!current) {
    return [];
  }

  const ports = current.ports
    .map(
      (port) =>
        `${port.hostIp ? `${port.hostIp}:` : ""}${port.hostPort}:${port.containerPort}${
          port.protocol !== "tcp" ? `/${port.protocol}` : ""
        }`,
    )
    .join(", ");
  const mounts = current.mounts
    .map((mount) => `${mount.destination}:${mount.source}${mount.readOnly ? " (ro)" : ""}`)
    .join("\n");
  const env = current.env.join("\n");

  const sections: DetailSection[] = [
    {
      label: t("container.detail.sectionOverview"),
      fields: [
        [t("container.detail.fieldName"), current.name],
        [t("container.detail.fieldId"), current.id.slice(0, 12)],
        [t("container.detail.fieldImage"), current.image],
        [t("container.detail.fieldState"), current.state],
        [t("container.detail.fieldRestart"), current.restartPolicy ?? ""],
      ],
    },
    {
      label: t("container.detail.sectionCommand"),
      fields: [
        [t("container.detail.fieldEntrypoint"), current.entrypoint ?? ""],
        [t("container.detail.fieldCommand"), current.command ?? ""],
        [t("container.detail.fieldWorkDir"), current.workDir ?? ""],
        [t("container.detail.fieldUser"), current.user ?? ""],
      ],
    },
    {
      label: t("container.detail.sectionNetwork"),
      fields: [
        [t("container.detail.fieldNetworkMode"), current.networkMode ?? ""],
        [t("container.detail.fieldIp"), current.ip ?? ""],
        [t("container.detail.fieldGateway"), current.gateway ?? ""],
        [t("container.detail.fieldPorts"), ports],
      ],
    },
    {
      label: t("container.detail.sectionMounts"),
      fields: mounts !== "" ? [[t("container.detail.sectionMounts"), mounts]] : [],
    },
    {
      label: t("container.detail.sectionEnv"),
      fields: env !== "" ? [[t("container.detail.sectionEnv"), env]] : [],
    },
    {
      // The labels live in the raw document rather than the curated detail, so the section reads
      // them out of it; a raw document that will not parse simply has no labels to show.
      label: t("container.detail.sectionLabels"),
      fields: labelsOf(current.raw).length > 0 ? [[t("container.detail.sectionLabels"), labelsOf(current.raw)]] : [],
    },
    {
      label: t("container.detail.sectionState"),
      fields: [
        [t("container.detail.fieldStartedAt"), current.startedAt ?? ""],
        [t("container.detail.fieldFinishedAt"), current.finishedAt ?? ""],
        [t("container.detail.fieldExitCode"), current.exitCode === undefined ? "—" : String(current.exitCode)],
        [t("container.detail.fieldPid"), current.pid > 0 ? String(current.pid) : "—"],
        [t("container.detail.fieldOom"), current.oomKilled ? t("container.detail.yes") : t("container.detail.no")],
      ],
    },
  ];

  return sections.filter((section) => section.fields.length > 0);
});

const prettyRaw = computed(() => {
  const raw = detail.value?.raw ?? "";
  if (raw === "") {
    return "";
  }
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
});

async function loadDetail(): Promise<void> {
  const target = props.target;
  if (!target) {
    return;
  }
  const generation = ++detailGeneration;
  detail.value = null;
  detailFailure.value = null;
  detailLoading.value = true;
  try {
    const answer = await containers.inspect(props.tabId, target.id);
    if (generation !== detailGeneration) {
      return;
    }
    detail.value = answer;
  } catch (error) {
    if (generation === detailGeneration) {
      detailFailure.value = describeShellError(translate, asShellError(error, "container_inspect")).message;
    }
  } finally {
    if (generation === detailGeneration) {
      detailLoading.value = false;
    }
  }
}

async function copyRaw(): Promise<void> {
  try {
    await navigator.clipboard.writeText(prettyRaw.value);
    copied.value = true;
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    // The clipboard is a convenience; the text is on screen and selectable either way.
  }
}

// -- logs ----------------------------------------------------------------------

const LOG_TAILS = [100, 500, 2000];
const tail = ref(500);
const timestamps = ref(false);
const wrap = ref(true);
const paused = ref(false);
const lines = ref<string[]>([]);
const backlog = ref<string[]>([]);
const logFailure = ref<string | null>(null);
const logEnded = ref(false);
/** The stream is being reopened for the container it was following: the view says so while it waits. */
const logReconnecting = ref(false);
const body = ref<HTMLElement | null>(null);
let logStream: string | null = null;
let logGeneration = 0;
/** How often the view asks whether the container it was following is back. */
const RESTART_POLL_MS = 1_000;
/** How long a stopped container's log view waits for it before it settles on the manual button. */
const RESTART_WINDOW_MS = 30_000;
/** Auto-reopens that ended without a single line are a stream that cannot hold on: stop trying. */
const RESTART_MAX_CONSECUTIVE_FAILURES = 3;
let restartTimer: number | null = null;
let autoReopensWithoutLines = 0;

const tailOptions = computed(() => LOG_TAILS.map((count) => ({ value: String(count), label: String(count) })));

function scrollToEnd(): void {
  void nextTick(() => {
    if (body.value) {
      body.value.scrollTop = body.value.scrollHeight;
    }
  });
}

function receive(line: string): void {
  autoReopensWithoutLines = 0;
  if (paused.value) {
    appendLogLine(backlog.value, line);
    return;
  }
  appendLogLine(lines.value, line);
  scrollToEnd();
}

function cancelRestartWatch(): void {
  if (restartTimer !== null) {
    window.clearInterval(restartTimer);
    restartTimer = null;
  }
}

async function stopLogs(): Promise<void> {
  logGeneration += 1;
  cancelRestartWatch();
  const stream = logStream;
  logStream = null;
  if (stream !== null) {
    await containers.stopStream(stream);
  }
}

/**
 * Watches for the container the stream was following to come back, and reopens the stream once it
 * has.
 *
 * `docker logs -f` ends when the container stops — a restart, a crash, a compose down. The honest
 * reading of the ended stream is "the thing it was reading stopped", so the view asks the list (which
 * the engine's own event stream keeps current) whether the container is running again, and reopens
 * when it is. One reopen per end, and only for the window below: a container that never comes back
 * leaves the view at the ended sentence and its manual restart button.
 */
function watchForRestart(generation: number): void {
  cancelRestartWatch();
  const target = props.target;
  if (!target) {
    return;
  }
  const deadline = Date.now() + RESTART_WINDOW_MS;
  restartTimer = window.setInterval(() => {
    if (generation !== logGeneration || props.mode !== "logs") {
      cancelRestartWatch();
      return;
    }
    const current = containers
      .sessionFor(props.tabId)
      ?.containers.find((container) => container.id === target.id);
    if (current?.state === "running") {
      cancelRestartWatch();
      void autoReopen(generation);
      return;
    }
    if (Date.now() > deadline) {
      cancelRestartWatch();
    }
  }, RESTART_POLL_MS);
}

/**
 * The one automatic reopen a stopped stream is allowed.
 *
 * A stream that ends again without a single line having arrived is not a restart: it is a stream
 * that cannot hold on. Three of those in a row hands the view back to the person, with the manual
 * button that was always there.
 */
async function autoReopen(previousGeneration: number): Promise<void> {
  if (previousGeneration !== logGeneration) {
    return;
  }
  logReconnecting.value = true;
  try {
    await startLogs(true);
  } finally {
    // The waiting sentence is the reopen's own: it ends when the reopen does, whatever became of
    // the stream it opened.
    logReconnecting.value = false;
  }
}

/** `auto` marks a reopen the view made by itself, whose ends count against the automatic limit. */
async function startLogs(auto = false): Promise<void> {
  await stopLogs();
  const target = props.target;
  lines.value = [];
  backlog.value = [];
  logFailure.value = null;
  logEnded.value = false;
  if (props.mode !== "logs" || !target) {
    return;
  }

  const generation = ++logGeneration;
  try {
    const stream = await containers.startLogs(props.tabId, target.id, tail.value, timestamps.value, {
      onLine: receive,
      onEnd: (error) => {
        if (generation !== logGeneration) {
          return;
        }
        logStream = null;
        if (error) {
          logFailure.value = error;
          return;
        }
        logEnded.value = true;
        if (auto) {
          // A reopen that ended without a single line is a stream that cannot hold on; three of
          // those in a row are the limit, and the manual button takes it from there. A line resets
          // the count — see `receive` — because a stream that carried logs is holding.
          autoReopensWithoutLines += 1;
          if (autoReopensWithoutLines >= RESTART_MAX_CONSECUTIVE_FAILURES) {
            return;
          }
        }
        watchForRestart(generation);
      },
    });
    if (generation !== logGeneration || props.mode !== "logs") {
      if (stream !== null) {
        await containers.stopStream(stream);
      }
      return;
    }
    logStream = stream;
  } catch (error) {
    if (generation === logGeneration) {
      logFailure.value = describeShellError(translate, asShellError(error, "container_logs")).message;
    }
  }
}

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

// -- lifecycle -----------------------------------------------------------------

watch(
  () => [props.mode, props.target?.id],
  () => {
    detailGeneration += 1;
    if (props.mode === "detail" && props.target) {
      tab.value = "detail";
      void loadDetail();
    } else {
      detail.value = null;
      detailFailure.value = null;
    }
    if (props.mode === "logs" && props.target) {
      void startLogs();
    } else {
      void stopLogs();
    }
  },
  { immediate: true },
);

// A new tail or a timestamp switch is a new stream: the backend decides both when it starts.
watch([tail, timestamps], () => {
  if (props.mode === "logs") {
    void startLogs();
  }
});

onBeforeUnmount(() => {
  window.clearTimeout(copyTimer);
  void stopLogs();
  // The buffer is this view's own memory; letting it go here keeps a closed drawer from pinning
  // five thousand lines until the tab itself closes.
  lines.value = [];
  backlog.value = [];
});
</script>

<template>
  <div v-if="props.mode !== null" class="absolute inset-0 z-20" @click.self="emit('close')">
    <div
      class="absolute inset-y-0 right-0 flex w-[min(40rem,100%)] flex-col border-l border-border bg-card shadow-xl"
      role="dialog"
      :aria-label="title"
    >
      <header class="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span class="min-w-0 truncate text-xs font-medium" :title="title">{{ title }}</span>
        <button
          type="button"
          class="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          :title="t('common.action.close')"
          :aria-label="t('common.action.close')"
          @click="emit('close')"
        >
          <X :size="12" />
        </button>
      </header>

      <template v-if="props.mode === 'detail'">
        <div class="flex shrink-0 gap-0.5 border-b border-border px-2">
          <button
            type="button"
            class="border-b-2 px-2 py-1 text-[11px] transition-colors"
            :class="
              tab === 'detail'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            "
            @click="tab = 'detail'"
          >
            {{ t("container.detail.tabDetail") }}
          </button>
          <button
            type="button"
            class="border-b-2 px-2 py-1 text-[11px] transition-colors"
            :class="
              tab === 'json'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            "
            @click="tab = 'json'"
          >
            {{ t("container.detail.tabJson") }}
          </button>
        </div>

        <div v-show="tab === 'detail'" class="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <p v-if="detailLoading" class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <LoaderCircle :size="12" class="animate-spin" />
            {{ t("container.detail.loading") }}
          </p>
          <p v-else-if="detailFailure" class="text-[11px] text-destructive select-text">{{ detailFailure }}</p>
          <section v-for="section in detailSections" :key="section.label" class="mb-3">
            <h3 class="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              {{ section.label }}
            </h3>
            <dl>
              <div
                v-for="field in section.fields"
                :key="field[0]"
                class="flex gap-3 border-b border-border/50 py-1 last:border-b-0"
              >
                <dt class="w-28 shrink-0 text-[10px] text-muted-foreground">{{ field[0] }}</dt>
                <dd class="min-w-0 flex-1 font-mono text-[11px] break-all whitespace-pre-wrap select-text">
                  {{ field[1] || "—" }}
                </dd>
              </div>
            </dl>
          </section>
        </div>

        <div v-show="tab === 'json'" class="flex min-h-0 flex-1 flex-col">
          <div class="shrink-0 border-b border-border px-3 py-1.5">
            <button
              type="button"
              class="rounded-md border border-border px-2 py-1 text-[11px] transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="prettyRaw === ''"
              @click="copyRaw()"
            >
              {{ copied ? t("container.detail.copied") : t("container.detail.copy") }}
            </button>
          </div>
          <pre class="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px] whitespace-pre-wrap select-text">{{
            prettyRaw
          }}</pre>
        </div>
      </template>

      <template v-else>
        <div class="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2.5 py-1.5">
          <Select
            :model-value="String(tail)"
            :options="tailOptions"
            size="compact"
            class="w-16"
            :aria-label="t('container.logs.tail')"
            @update:model-value="tail = Number($event)"
          />
          <label class="flex items-center gap-1 text-[11px] text-muted-foreground">
            <input v-model="timestamps" type="checkbox" class="size-3 accent-[var(--primary)]" />
            {{ t("container.logs.timestamps") }}
          </label>
          <button
            type="button"
            class="flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] transition-colors"
            :class="
              wrap ? 'border-primary/50 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'
            "
            :aria-pressed="wrap"
            @click="wrap = !wrap"
          >
            <WrapText :size="10" />
            {{ t("container.logs.wrap") }}
          </button>
          <button
            type="button"
            class="rounded-sm border px-1.5 py-0.5 text-[10px] transition-colors"
            :class="
              errorsOnly
                ? 'border-destructive/50 text-destructive'
                : 'border-border text-muted-foreground hover:text-foreground'
            "
            :aria-pressed="errorsOnly"
            data-logs-errors-only
            @click="errorsOnly = !errorsOnly"
          >
            {{ t("container.logs.errorsOnly") }}
          </button>
          <button
            type="button"
            class="rounded-sm border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
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
          <button
            type="button"
            class="grid size-5 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            :title="t('container.logs.restart')"
            :aria-label="t('container.logs.restart')"
            @click="startLogs()"
          >
            <RotateCw :size="11" />
          </button>
          <span v-if="paused" class="text-[10px] text-muted-foreground">{{ t("container.logs.paused") }}</span>
          <span
            v-if="logReconnecting"
            class="flex items-center gap-1 text-[10px] text-muted-foreground"
            data-logs-reconnecting
          >
            <LoaderCircle :size="10" class="animate-spin" />
            {{ t("container.logs.reconnecting") }}
          </span>
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
          :aria-label="t('container.logs.title', { name: props.target?.name ?? '' })"
        >
          <p v-if="lines.length === 0" class="text-[11px] text-muted-foreground" data-logs-empty>
            {{ t("container.logs.empty") }}
          </p>
          <p v-else-if="shownLines.length === 0" class="text-[11px] text-muted-foreground" data-logs-no-errors>
            {{ t("container.logs.noErrors") }}
          </p>
          <div
            v-for="(line, index) in shownLines"
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
      </template>
    </div>
  </div>
</template>
