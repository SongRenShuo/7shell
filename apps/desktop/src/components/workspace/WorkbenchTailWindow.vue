<script setup lang="ts">
/**
 * The desktop's log-tracking window: a file on the far side, followed line by line.
 *
 * What it is, is `tail -F` with a face. The window itself owns only three things, because the
 * stream's whole lifecycle belongs to the store keyed by this window's id:
 *
 * 1. **The ask.** A path that has to be absolute on the far side — a relative one would resolve
 *    against whatever directory the shell lands in, a file nobody meant — and how much of the file
 *    to read first. The scenario sentences are there because the feature's name is abstract and a
 *    path is not: "system log" becomes real when the example is `/var/log/syslog`.
 * 2. **The reading.** A monospaced view that sticks to the bottom while the file grows, and stops
 *    sticking the moment somebody scrolls up to read history — a view that yanks itself back to
 *    the newest line while somebody is reading an older one is a view nobody can read.
 * 3. **The long-stream rule.** A tail is a stream that never ends on its own, so it pauses when
 *    the window is not in front — minimised, or the desktop tab hidden — and resumes when it is
 *    back. When the window goes away entirely, the store's stop is what cancels the stream; a
 *    closed window that kept reading would be a leak with the person long gone.
 *
 * A pause is not free: `-F` is the far side's business, so what was written while nobody read is
 * missed, and the copy under the paused view says so instead of implying otherwise.
 *
 * Beside the count in the reading's header is the rate the lines land at — one bar a second while
 * the window follows, the last minute of them, gathered here rather than arriving from the far
 * side. It stands still when the stream does: a paused bar is the rate that was, not a zero.
 */
import { LoaderCircle } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import SparkBars from "@/components/charts/SparkBars.vue";
import Select, { type SelectOption } from "@/components/ui/Select.vue";
import WbButton from "@/components/ui/WbButton.vue";
import { describeShellError } from "@/i18n/errors";
import { TAIL_OPEN_SIZES, isValidTailPath, useTailStore, type TailState } from "@/stores/tail";

const props = defineProps<{
  /** The session whose connection the stream rides on. */
  sessionId: string;
  /** This window's own id on the desktop — the key the store keeps the tail under. */
  windowId: string;
  /** Whether this window is in front. A hidden window's stream is paused, not stopped. */
  active: boolean;
}>();

const { t } = useI18n();
const tails = useTailStore();

// The window's state exists from the first draw; it is read back rather than kept, because a stop
// deletes the entry and the window draws the ask again from a fresh one.
tails.ensure(props.windowId);
const state = computed<TailState | null>(() => tails.tailOf(props.windowId) ?? null);

// -- the ask -----------------------------------------------------------------

const path = ref("");
const size = ref<number>(TAIL_OPEN_SIZES[0] ?? 200);

const SIZES: SelectOption[] = TAIL_OPEN_SIZES.map((count) => ({
  value: String(count),
  label: String(count),
}));

/** Whether the typed path may be followed; said in the form rather than guessed at the open. */
const pathOk = computed(() => isValidTailPath(path.value.trim()));

/** Whether the follow button has anything it can act on. */
const canFollow = computed(() => pathOk.value && (state.value?.status ?? "idle") !== "connecting");

function follow(): void {
  if (!pathOk.value) {
    return;
  }
  void tails.follow(props.windowId, props.sessionId, path.value.trim(), size.value);
}

/**
 * The one button that means both directions: follow when the stream is not live, pause when it is.
 * A paused window resumes through it too, because "follow again" and "resume" are the same ask.
 */
function toggle(): void {
  const current = state.value?.status ?? "idle";
  if (current === "following" || current === "connecting") {
    void tails.pause(props.windowId);
    return;
  }
  if (current === "paused") {
    void tails.resume(props.windowId);
    return;
  }
  follow();
}

/** Stops for good: the stream is cancelled and the reading is thrown away. */
function stop(): void {
  void tails.stop(props.windowId).then(() => tails.ensure(props.windowId));
}

// -- the reading ---------------------------------------------------------------

/** How many lines the view holds; the count is part of what the header says. */
const count = computed(() => state.value?.lines.length ?? 0);

/** Whether the view is pinned to the newest line, which is the default until somebody scrolls up. */
const pinned = ref(true);

/** The scrolling element, so a new line can move it without a render-time ref callback. */
const linesView = ref<HTMLElement | null>(null);

/** Where the view scrolls; near-enough to the bottom counts as pinned, so a rounding gap does not unpause the stickiness. */
function onScroll(event: Event): void {
  const view = event.target as HTMLElement;
  pinned.value = view.scrollTop + view.clientHeight >= view.scrollHeight - 8;
}

/** Keeps the newest line on screen while pinned — and does nothing while somebody reads history. */
function stick(): void {
  if (pinned.value && linesView.value) {
    linesView.value.scrollTop = linesView.value.scrollHeight;
  }
}

watch(count, () => {
  void nextTick(stick);
});

// -- the long-stream rule -------------------------------------------------------

/**
 * A hidden window does not keep reading: the host turns `active` off when the window is minimised
 * or the desktop tab is not the one showing, and the stream pauses itself; back in front, it
 * resumes from the same path. A stream that kept running behind a closed blind would be the
 * feature's own budget quietly spent by nobody.
 */
watch(
  () => props.active,
  (now) => {
    const current = state.value?.status ?? "idle";
    if (!now && current === "following") {
      void tails.pause(props.windowId);
    } else if (now && current === "paused") {
      void tails.resume(props.windowId);
    }
  },
);

onBeforeUnmount(() => {
  // The window going away cancels the stream outright: nothing that outlives the person who asked.
  void tails.stop(props.windowId);
});

// -- the line frequency ---------------------------------------------------------

/**
 * How fast lines arrive, drawn as the minute behind the reading: one sample a second while the
 * stream is followed, sixty of them, each the number of lines that landed in that second. The
 * samples are gathered here rather than arriving from anywhere — the store keeps lines, not a
 * rate — and they gather only while the stream is live:
 *
 * - **following** samples; **paused** and **ended** stop sampling and keep what was drawn, which
 *   is the rate that *was* rather than a zero that never was; **idle** (the ask again) empties
 *   the bar, because a fresh follow is a fresh minute.
 */
const FREQ_INTERVAL_MS = 1000;
const FREQ_POINTS = 60;

const frequency = ref<number[]>([]);
let frequencyLastCount = 0;
let frequencyTimer: ReturnType<typeof setInterval> | undefined;

function stopFrequency(): void {
  if (frequencyTimer !== undefined) {
    clearInterval(frequencyTimer);
    frequencyTimer = undefined;
  }
}

function startFrequency(): void {
  if (frequencyTimer !== undefined) {
    return;
  }
  frequencyLastCount = count.value;
  frequencyTimer = setInterval(() => {
    const arrived = Math.max(0, count.value - frequencyLastCount);
    frequencyLastCount = count.value;
    frequency.value = [...frequency.value, arrived].slice(-FREQ_POINTS);
  }, FREQ_INTERVAL_MS);
}

watch(
  () => state.value?.status ?? "idle",
  (status) => {
    if (status === "following") {
      startFrequency();
      return;
    }
    stopFrequency();
    if (status === "idle") {
      frequency.value = [];
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  stopFrequency();
});

const frequencySeries = computed(() => [{ values: frequency.value, class: "bg-primary/50" }]);

// -- what the state says ---------------------------------------------------------

function translate(key: string, params?: Record<string, string>): string {
  return params ? t(key, params) : t(key);
}

/** The open's refusal, in the language the window is drawn in. */
const describedFailure = computed(() =>
  state.value?.failure ? describeShellError(translate, state.value.failure) : null,
);
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col overflow-hidden" data-workbench-tail-window>
    <!--
      The ask, drawn while nothing is being followed. Once a stream is live the form makes way for
      the reading — the path being followed is named in the reading's header instead.
    -->
    <div v-if="state === null || state.status === 'idle'" class="mx-auto w-full max-w-lg space-y-4 overflow-auto p-5">
      <div class="space-y-1">
        <label class="block">
          <span class="mb-1 block text-xs font-medium">{{ t("workbench.desktop.tail.pathLabel") }}</span>
          <input
            v-model="path"
            type="text"
            spellcheck="false"
            class="w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs focus:border-primary focus:outline-none"
            :placeholder="t('workbench.desktop.tail.pathPlaceholder')"
            @keydown.enter="follow()"
          />
        </label>
        <p v-if="path !== '' && !pathOk" class="text-[11px] text-destructive">
          {{ t("workbench.desktop.tail.pathInvalid") }}
        </p>
      </div>

      <div class="flex items-center gap-2 text-xs">
        <span class="text-muted-foreground">{{ t("workbench.desktop.tail.sizeLabel") }}</span>
        <Select
          :model-value="String(size)"
          :options="SIZES"
          size="compact"
          :aria-label="t('workbench.desktop.tail.sizeLabel')"
          trigger-class="font-mono"
          @update:model-value="size = Number($event)"
        />
      </div>

      <!--
        The one primary action of the ask, in the desktop's own primary voice — the accent the
        docker window's create speaks — and inline at the row's end, the rhythm the other windows'
        forms keep, rather than a bar stretching the ask's whole width.
      -->
      <div class="flex items-center justify-end">
        <WbButton variant="primary" :disabled="!canFollow" data-workbench-tail-follow @click="follow()">
          {{ t("workbench.desktop.tail.follow") }}
        </WbButton>
      </div>

      <!-- The scenarios, because "follow a log" is abstract and a path is not. -->
      <div
        class="space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground"
      >
        <p>{{ t("workbench.desktop.tail.hint.syslog") }}</p>
        <p>{{ t("workbench.desktop.tail.hint.nginx") }}</p>
        <p>{{ t("workbench.desktop.tail.hint.missed") }}</p>
      </div>
    </div>

    <!--
      The reading: header with the path, the count and the one button that means follow and pause;
      below it, the lines.
    -->
    <template v-else>
      <header class="flex items-center gap-2 border-b border-border px-3 py-[var(--panel-header-y)]">
        <code class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" :title="state.path">
          {{ state.path }}
        </code>
        <!--
          How fast the lines land, for as long as the window has been following. It draws nothing
          until the first second has answered, and once drawn it moves only while the stream does.
        -->
        <SparkBars
          v-if="frequency.length > 0"
          class="w-24 shrink-0"
          height-class="h-3"
          :series="frequencySeries"
          :label="t('workbench.desktop.tail.frequency')"
          data-workbench-tail-frequency
        />
        <span class="nums shrink-0 text-[11px] text-muted-foreground">
          {{ t("workbench.desktop.tail.count", { count }) }}
        </span>
        <button
          type="button"
          class="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] transition-colors hover:bg-accent"
          :disabled="state.status === 'connecting'"
          data-workbench-tail-follow
          @click="toggle()"
        >
          {{
            state.status === "following" || state.status === "connecting"
              ? t("workbench.desktop.tail.pause")
              : t("workbench.desktop.tail.follow")
          }}
        </button>
        <button
          type="button"
          class="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] transition-colors hover:bg-accent"
          @click="stop()"
        >
          {{ t("workbench.desktop.tail.stop") }}
        </button>
      </header>

      <!--
        The three state lines under the header, one shape for all: a thin banner, the muted voice
        for the ordinary ones, the destructive one for the end that carried a reason. The open's
        wait is a single thing being waited for, so it keeps the spinner rather than a skeleton.
      -->
      <div
        v-if="state.status === 'connecting'"
        class="flex items-center gap-2 border-b border-border bg-accent/30 px-4 py-2 text-[11px] text-muted-foreground"
      >
        <LoaderCircle :size="11" class="animate-spin" />
        {{ t("workbench.desktop.tail.connecting") }}
      </div>

      <div
        v-else-if="state.status === 'paused'"
        class="border-b border-border bg-accent/30 px-4 py-2 text-[11px] text-muted-foreground"
      >
        {{ t("workbench.desktop.tail.pausedNotice") }}
      </div>

      <div
        v-else-if="state.status === 'ended'"
        class="px-4 py-2 text-[11px]"
        :class="describedFailure || state.error ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground'"
      >
        <template v-if="describedFailure">
          <p>{{ describedFailure.message }}</p>
          <p class="font-mono text-[10px] text-muted-foreground">{{ describedFailure.code }}</p>
        </template>
        <p v-else-if="state.error">{{ state.error }}</p>
        <p v-else>{{ t("workbench.desktop.tail.ended") }}</p>
      </div>

      <!--
        The lines themselves. `text-left` keeps the monospace face flush, and the watch on the
        count is what sticks the view to the newest line while it is pinned there.
      -->
      <div
        ref="linesView"
        class="min-h-0 flex-1 overflow-auto bg-background px-3 py-2 text-left"
        data-workbench-tail-lines
        @scroll="onScroll"
      >
        <p
          v-for="(line, index) in state.lines"
          :key="`${index}-${line}`"
          class="whitespace-pre-wrap break-all font-mono text-[11px] leading-[1.6] text-foreground"
        >
          {{ line }}
        </p>
        <p v-if="state.lines.length === 0" class="text-[11px] text-muted-foreground">
          {{ t("workbench.desktop.tail.waiting") }}
        </p>
      </div>
    </template>
  </section>
</template>
