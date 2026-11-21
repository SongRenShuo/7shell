<script setup lang="ts">
/**
 * One command, many hosts.
 *
 * The panel is read in the order a run happens: pick the hosts, write the command, look at what the
 * classifier says about it, run, then read one row per host. The verdict sits between the box and
 * the button on purpose — it is the last thing read before pressing something that reaches ten
 * machines at once — and the button that ignores it is the second step, behind a checkbox that says
 * the reasons were read.
 *
 * What the panel refuses to do is pretend: hosts are listed with their addresses rather than their
 * names alone (a name says nothing about which machine is about to be changed), a row that has not
 * answered shows nothing rather than a spinner that implies progress, and a run stopped by a host
 * key decision says so instead of looking like it is still going.
 */
import { Check, CircleAlert, History, ListChecks, LoaderCircle, Play, RotateCw, Trash2, X } from "@lucide/vue";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { computed, nextTick, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import BatchHostRow from "@/components/batch/BatchHostRow.vue";
import Select, { type SelectOption } from "@/components/ui/Select.vue";
import WbEmpty from "@/components/ui/WbEmpty.vue";
import { describeShellError } from "@/i18n/errors";
import { atLeast, needsApproval } from "@/lib/batch/risk";
import { clearHistory, loadHistory, pushHistory } from "@/lib/batch/history";
import { useBatchStore } from "@/stores/batch";
import { useSessionEditorStore } from "@/stores/sessionEditor";
import { useSessionsStore } from "@/stores/sessions";
import { useTerminalsStore } from "@/stores/terminals";
import type { RiskLevel } from "@/types/batch";

const { t } = useI18n();
const batch = useBatchStore();
const library = useSessionsStore();
const terminals = useTerminalsStore();
const editor = useSessionEditorStore();

/**
 * What a batch can run on: an SSH connection, because the command travels over its exec channel.
 * A Telnet console, a serial port or a local shell has no such channel, so it is not offered.
 */
const hosts = computed(() => library.sessions.filter((session) => session.protocol === "ssh"));

/**
 * Why the host list is empty, which decides what it says.
 *
 * An empty library and a library whose sessions are all consoles batch cannot reach look the same
 * in the list, but they are different news: the first asks for a first session, the second says
 * the sessions that exist are not the kind a batch can ride.
 */
const hostsEmptyKey = computed(() => (library.sessions.length === 0 ? "batch.hosts.empty" : "batch.hosts.emptyNoSsh"));

const LEVEL_STYLES: Record<RiskLevel, string> = {
  safe: "border-border bg-background text-muted-foreground",
  caution: "border-warning/40 bg-warning/10 text-warning",
  destructive: "border-destructive/40 bg-destructive/10 text-destructive",
  catastrophic: "border-destructive bg-destructive/15 text-destructive",
};

/** Whether a host key is being asked about right now, and it is this panel's request. */
const waitingForDecision = computed(() => terminals.decision !== null && terminals.decision.target.to === "batch");

function translate(key: string, params?: Record<string, string>): string {
  return params ? t(key, params) : t(key);
}

const describedFailure = computed(() => (batch.failure ? describeShellError(translate, batch.failure) : null));

/** How long the whole run took, in the unit a person reads it in. */
const summaryDuration = computed(() => {
  const ms = batch.finished?.durationMs ?? 0;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
});

const level = computed(() => batch.risk?.level ?? null);
const showVerdict = computed(() => batch.command.trim() !== "" && batch.risk !== null && level.value !== null);

/** The hosts whose row is already answered, for the "3 of 7" line while a run is going. */
const answered = computed(() => batch.rows.filter((row) => row.status === "done").length);
const unfinished = computed(() => batch.failedIds.length);

const retrying = ref(false);

/**
 * The commands this panel has run, kept for recall.
 *
 * `history` mirrors the store on this device (`lib/batch/history`); `historyIndex` is where the
 * arrow keys are in that list, null meaning at the present — and `draftBeforeRecall` holds what
 * the box said before the first recall, because walking back through history must be able to
 * walk forward into it again.
 */
const history = ref<string[]>([]);
const historyIndex = ref<number | null>(null);
const historyOpen = ref(false);
const draftBeforeRecall = ref("");

/** Re-reads the store when the popover opens: the run that just happened is already in it. */
function refreshHistory(): void {
  history.value = loadHistory();
}

function pickHistory(command: string): void {
  historyOpen.value = false;
  historyIndex.value = null;
  batch.setCommand(command);
}

function clearAllHistory(): void {
  clearHistory();
  history.value = [];
  historyIndex.value = null;
}

/** Whether the caret sits on the textarea's first (or last) line, which is where recall lives. */
function caretLine(field: HTMLTextAreaElement): number {
  return field.value.slice(0, field.selectionStart ?? 0).split("\n").length - 1;
}

function isLastLine(field: HTMLTextAreaElement): boolean {
  return caretLine(field) >= field.value.split("\n").length - 1;
}

/** Up on the first line walks back through history; the caret parks at the start to keep walking. */
function recallPrevious(): void {
  if (history.value.length === 0) {
    return;
  }
  if (historyIndex.value === null) {
    draftBeforeRecall.value = batch.command;
    historyIndex.value = 0;
  } else {
    historyIndex.value = Math.min(historyIndex.value + 1, history.value.length - 1);
  }
  batch.setCommand(history.value[historyIndex.value] ?? "");
  void nextTick().then(() => {
    const field = document.querySelector<HTMLTextAreaElement>("[data-batch-command]");
    if (field !== null) {
      field.selectionStart = 0;
      field.selectionEnd = 0;
    }
  });
}

/** Down walks forward, and past the newest entry hands the box back what it said before. */
function recallNext(): void {
  if (historyIndex.value === null) {
    return;
  }
  const next = historyIndex.value - 1;
  historyIndex.value = next === -1 ? null : next;
  batch.setCommand(next === -1 ? draftBeforeRecall.value : (history.value[next] ?? ""));
}

/** The textarea's keydown: only the arrows that recall history are intercepted, and only when the caret is at the edge the gesture means. */
function onCommandKeydown(event: KeyboardEvent): void {
  const field = event.target;
  if (!(field instanceof HTMLTextAreaElement) || field.selectionStart !== field.selectionEnd) {
    return;
  }
  if (event.key === "ArrowUp" && caretLine(field) === 0) {
    event.preventDefault();
    recallPrevious();
  } else if (event.key === "ArrowDown" && isLastLine(field) && historyIndex.value !== null) {
    event.preventDefault();
    recallNext();
  }
}

/** The two choices the run has, as the interface's own dropdown rather than the platform's. */
const TIMEOUTS: SelectOption[] = [
  { value: "10000", label: "10s" },
  { value: "30000", label: "30s" },
  { value: "120000", label: "2min" },
  { value: "600000", label: "10min" },
];

const PARALLEL: SelectOption[] = [1, 2, 4, 8, 16].map((count) => ({ value: String(count), label: String(count) }));

onMounted(() => {
  batch.listen();
  history.value = loadHistory();
});

/** Runs, once the checkbox has said the reasons were read — when there are reasons to read. */
async function run(): Promise<void> {
  if (batch.blocked === "approval") {
    return;
  }
  if (batch.approval) {
    await runAcknowledged();
    return;
  }
  history.value = pushHistory(batch.command);
  historyIndex.value = null;
  await batch.run();
}

async function retryFailed(): Promise<void> {
  retrying.value = true;
  try {
    await batch.retryFailed();
  } finally {
    retrying.value = false;
  }
}

async function retryOne(sessionId: string): Promise<void> {
  retrying.value = true;
  try {
    await batch.retryOne(sessionId);
  } finally {
    retrying.value = false;
  }
}

/** The acknowledged run reaches the machines, so it is the history's entry point too. */
async function runAcknowledged(): Promise<void> {
  history.value = pushHistory(batch.command);
  historyIndex.value = null;
  await batch.runAcknowledged();
}
</script>

<template>
  <div class="flex h-full min-h-0">
    <!--
      The host picker. It reads the saved sessions rather than a list of its own: a batch runs on
      the connections somebody already has, and a second place to name a host would be a second
      place for the address to be wrong.
    -->
    <aside class="flex w-72 shrink-0 flex-col border-r border-border">
      <header class="flex items-center justify-between gap-2 border-b border-border px-3 py-[var(--panel-header-y)]">
        <h2 class="text-xs font-medium">{{ t("batch.hosts.title") }}</h2>
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            @click="batch.selectAll()"
          >
            {{ t("batch.hosts.all") }}
          </button>
          <button
            type="button"
            class="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            @click="batch.clearSelection()"
          >
            {{ t("batch.hosts.none") }}
          </button>
        </div>
      </header>

      <!--
        The empty list says why it is empty and hands over the one act that changes it: the hosts
        come from the session library, and a new session is the way a host gets in.
      -->
      <div
        v-if="hosts.length === 0"
        class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-3 py-4 text-center"
        data-batch-hosts-empty
      >
        <WbEmpty
          scenario="noData"
          size="sm"
          :title="t(hostsEmptyKey)"
          :description="t('batch.hosts.emptyHint')"
          class="text-muted-foreground"
        />
        <button
          type="button"
          data-batch-new-session
          class="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          @click="editor.startNew()"
        >
          {{ t("sessions.newTab.newSession") }}
        </button>
      </div>

      <ul v-else class="min-h-0 flex-1 overflow-auto py-1">
        <li v-for="session in hosts" :key="session.id">
          <label
            class="flex cursor-pointer items-start gap-2 px-3 py-1.5 transition-colors hover:bg-accent/50"
            :class="batch.selected.has(session.id) ? 'bg-accent/30' : ''"
          >
            <input
              type="checkbox"
              class="mt-0.5 size-3.5 shrink-0 accent-primary"
              :checked="batch.selected.has(session.id)"
              @change="batch.toggle(session.id)"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-xs">{{ session.name }}</span>
              <span class="block truncate font-mono text-[10px] text-muted-foreground">
                {{ session.user }}@{{ session.host }}:{{ session.port }}
              </span>
            </span>
          </label>
        </li>
      </ul>

      <footer class="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
        {{ t("batch.hosts.selected", { count: batch.selected.size }) }}
      </footer>
    </aside>

    <section class="flex min-w-0 flex-1 flex-col">
      <div class="space-y-3 border-b border-border px-4 py-3">
        <label class="block">
          <span class="mb-1 flex items-center justify-between">
            <span class="text-xs font-medium">{{ t("batch.command.label") }}</span>
            <PopoverRoot v-model:open="historyOpen">
              <PopoverTrigger as-child>
                <button
                  type="button"
                  data-batch-history
                  class="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  :title="t('batch.history.title')"
                  :aria-label="t('batch.history.title')"
                  @click="refreshHistory()"
                >
                  <History :size="11" />
                  {{ t("batch.history.title") }}
                </button>
              </PopoverTrigger>
              <PopoverPortal>
                <PopoverContent
                  align="end"
                  side="bottom"
                  :side-offset="4"
                  class="z-50 w-96 rounded-md border border-border bg-background p-1 shadow-md"
                >
                  <div
                    v-if="history.length === 0"
                    class="px-2 py-2 text-[11px] text-muted-foreground"
                    data-batch-history-empty
                  >
                    {{ t("batch.history.empty") }}
                  </div>
                  <template v-else>
                    <div class="max-h-64 overflow-auto" data-batch-history-list>
                      <button
                        v-for="(entry, index) in history"
                        :key="`${index}:${entry}`"
                        type="button"
                        data-batch-history-entry
                        class="flex h-6 w-full items-center gap-1.5 rounded-sm px-2 text-left font-mono text-[11px] transition-colors hover:bg-accent hover:text-foreground"
                        :title="entry"
                        @click="pickHistory(entry)"
                      >
                        <span class="min-w-0 flex-1 truncate">{{ entry }}</span>
                      </button>
                    </div>
                    <div class="border-t border-border pt-1">
                      <button
                        type="button"
                        data-batch-history-clear
                        class="flex h-6 w-full items-center gap-1.5 rounded-sm px-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        @click="clearAllHistory()"
                      >
                        <Trash2 :size="11" />
                        <span>{{ t("batch.history.clear") }}</span>
                      </button>
                    </div>
                  </template>
                </PopoverContent>
              </PopoverPortal>
            </PopoverRoot>
          </span>
          <textarea
            :value="batch.command"
            rows="3"
            spellcheck="false"
            data-batch-command
            class="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs focus:border-primary focus:outline-none"
            :placeholder="t('batch.command.placeholder')"
            @input="batch.setCommand(($event.target as HTMLTextAreaElement).value)"
            @keydown="onCommandKeydown"
          ></textarea>
        </label>

        <div class="flex flex-wrap items-center gap-3 text-xs">
          <div class="flex items-center gap-1.5">
            <span class="text-muted-foreground">{{ t("batch.options.timeout") }}</span>
            <Select
              :model-value="String(batch.timeoutMs)"
              :options="TIMEOUTS"
              size="compact"
              :aria-label="t('batch.options.timeout')"
              trigger-class="font-mono"
              @update:model-value="batch.timeoutMs = Number($event)"
            />
          </div>

          <div class="flex items-center gap-1.5">
            <span class="text-muted-foreground">{{ t("batch.options.parallel") }}</span>
            <Select
              :model-value="String(batch.parallel)"
              :options="PARALLEL"
              size="compact"
              :aria-label="t('batch.options.parallel')"
              trigger-class="font-mono"
              @update:model-value="batch.parallel = Number($event)"
            />
          </div>

          <div class="flex-1"></div>

          <button
            v-if="batch.finished && unfinished > 0"
            type="button"
            class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 transition-colors hover:bg-accent disabled:opacity-50"
            :disabled="batch.running || retrying"
            @click="retryFailed()"
          >
            <RotateCw :size="12" />
            {{ t("batch.action.retryFailed", { count: unfinished }) }}
          </button>

          <button
            type="button"
            class="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!batch.canRun"
            @click="run()"
          >
            <LoaderCircle v-if="batch.running" :size="12" class="animate-spin" />
            <Play v-else :size="12" />
            {{ batch.running ? t("batch.action.running") : t("batch.action.run") }}
          </button>
        </div>

        <!--
          The verdict, where it is read: between the command and the button. It is the backend's own
          answer, asked for as the command is typed, so what is shown here and what the run enforces
          are the same rules.
        -->
        <div v-if="showVerdict && level" class="rounded-md border px-3 py-2 text-xs" :class="LEVEL_STYLES[level]">
          <div class="flex items-center gap-2">
            <CircleAlert v-if="atLeast(level, 'destructive')" :size="13" />
            <Check v-else-if="level === 'safe'" :size="13" />
            <CircleAlert v-else :size="13" />
            <span class="font-medium">{{ t(`risk.level.${level}`) }}</span>
            <span v-if="batch.risk && batch.risk.reasons.length > 0" class="text-[11px] opacity-80">
              {{ batch.risk.reasons.map((reason) => t(reason.labelKey)).join(" · ") }}
            </span>
          </div>

          <label v-if="needsApproval(level)" class="mt-2 flex items-start gap-2 text-[11px]">
            <input
              type="checkbox"
              class="mt-0.5 size-3.5 shrink-0 accent-primary"
              :checked="batch.acknowledged"
              @change="batch.acknowledge()"
            />
            <span>{{ t("batch.risk.confirm", { count: batch.selected.size }) }}</span>
          </label>
        </div>

        <p v-if="batch.blocked === 'approval'" class="text-[11px] text-muted-foreground">
          {{ t("batch.risk.blocked") }}
        </p>
      </div>

      <!--
        Where the run is. A host key decision stops everything before anything runs, so it is said
        here rather than left to the dialog alone: somebody looking at the panel has to know why
        nothing is happening.
      -->
      <div
        v-if="waitingForDecision"
        class="flex items-center gap-2 border-b border-border bg-accent/40 px-4 py-2 text-xs text-muted-foreground"
      >
        <LoaderCircle :size="12" class="animate-spin" />
        {{ t("batch.state.decision") }}
      </div>

      <div
        v-else-if="batch.running && batch.rows.length > 0"
        class="flex items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground"
      >
        <LoaderCircle :size="12" class="animate-spin" />
        {{ t("batch.state.running", { done: answered, total: batch.rows.length }) }}
      </div>

      <div v-else-if="batch.approval" class="flex items-center gap-2 border-b border-border px-4 py-2 text-xs">
        <CircleAlert :size="13" class="text-destructive" />
        {{ t("batch.state.approval") }}
      </div>

      <div
        v-else-if="describedFailure"
        class="flex items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs"
      >
        <span class="min-w-0 flex-1">
          <p>{{ describedFailure.message }}</p>
          <p class="font-mono text-[10px] text-muted-foreground">{{ describedFailure.code }}</p>
        </span>
        <button
          type="button"
          class="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          :title="t('common.action.close')"
          :aria-label="t('common.action.close')"
          @click="batch.dismissFailure()"
        >
          <X :size="11" />
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-auto">
        <div v-if="batch.rows.length === 0" class="grid h-full place-items-center px-6 text-center">
          <div class="max-w-sm space-y-1.5">
            <ListChecks :size="20" class="mx-auto text-muted-foreground/60" />
            <p class="text-xs text-muted-foreground">{{ t("batch.empty.hint") }}</p>
          </div>
        </div>

        <template v-else>
          <div
            v-if="batch.finished"
            class="flex items-center gap-2 border-b border-border bg-accent/20 px-4 py-2 text-[11px] text-muted-foreground"
          >
            <span class="min-w-0 flex-1 truncate">
              {{ t("batch.summary.line", { done: answered, total: batch.rows.length, duration: summaryDuration }) }}
            </span>
            <code class="max-w-[40%] truncate font-mono">{{ batch.finished.command }}</code>
          </div>
          <ul>
            <BatchHostRow
              v-for="row in batch.rows"
              :key="row.sessionId"
              :row="row"
              :retrying="retrying || batch.running"
              @retry="retryOne"
            />
          </ul>
        </template>
      </div>
    </section>
  </div>
</template>
