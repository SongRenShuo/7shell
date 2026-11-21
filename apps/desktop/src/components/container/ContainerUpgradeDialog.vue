<script setup lang="ts">
/**
 * The upgrade dialog: the one question before a container is rebuilt from its own parameters.
 *
 * The dialog does its reading before it asks: the container's inspect answers for the parameters
 * the replacement will run with, and the registry answers whether the image's tag has actually
 * moved. A tag that has not moved closes the question — rebuilding would cost the container's own
 * layer and change nothing else, so the button refuses. A registry that would not speak is a
 * warning rather than a wall: the pull itself decides, and a pull that answers "up to date" stops
 * the transaction before anything destructive happens.
 *
 * The transaction runs in its fixed order (see `upgrade.ts`), and every failure lands somewhere
 * with its own way out: before the removal, the old container is intact and the error is the whole
 * story; after it, the dialog says the old container is gone, keeps the request it was going to
 * send, and offers to send it again — the original image is still on the engine, so a manual way
 * back exists either way.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import ContainerDialog from "@/components/container/ContainerDialog.vue";
import WbButton from "@/components/ui/WbButton.vue";
import { describeShellError } from "@/i18n/errors";
import { useToast } from "@/composables/useToast";
import { backend } from "@/lib/backend/api";
import { asShellError } from "@/lib/backend/errors";
import { useContainerStore, type ContainerSession } from "@/stores/container";
import type {
  ContainerCreateRequest,
  ContainerDetail,
  ContainerImageRemoteDigest,
  ContainerSummary,
} from "@/types/container";

import {
  runUpgradeTransaction,
  upgradeRequestFrom,
  type UpgradeOutcome,
  type UpgradePhase,
  type UpgradeSteps,
} from "./upgrade";

const props = defineProps<{
  open: boolean;
  /** The tab the container lives in, for the reads and the refresh after a run. */
  tabId: string;
  session: ContainerSession;
  /** The container being upgraded; null when the dialog is closed. */
  target: ContainerSummary | null;
}>();

const emit = defineEmits<{ (event: "update:open", value: boolean): void }>();

const { t } = useI18n();
const containers = useContainerStore();
const { toast } = useToast();

function translate(key: string, params?: Record<string, string>): string {
  return params ? t(key, params) : t(key);
}

function describe(error: unknown, operation: string): string {
  return describeShellError(translate, asShellError(error, operation)).message;
}

// -- the reading the dialog opens with ---------------------------------------------

const checking = ref(false);
const detail = ref<ContainerDetail | null>(null);
const digest = ref<ContainerImageRemoteDigest | null>(null);
const checkFailure = ref<string | null>(null);

/** A tag the registry says has not moved: nothing to upgrade, and nothing worth the container's
 * own layer. Absent means the registry did not answer, which is a warning, not a refusal. */
const tagMoved = computed(() => digest.value?.upToDate === false);
const tagCurrent = computed(() => digest.value?.upToDate === true);

watch(
  () => [props.open, props.target?.id] as const,
  ([open]) => {
    if (!open || !props.target || props.session.connectionId === null) {
      return;
    }
    void readTarget();
  },
);

async function readTarget(): Promise<void> {
  const connectionId = props.session.connectionId;
  const target = props.target;
  if (connectionId === null || target === null) {
    return;
  }
  checking.value = true;
  checkFailure.value = null;
  detail.value = null;
  digest.value = null;
  try {
    const read = await backend.containers.inspect(connectionId, target.id);
    detail.value = read;
  } catch (error) {
    checkFailure.value = describe(error, "container_inspect");
    checking.value = false;
    return;
  }
  try {
    digest.value = await backend.dockerRegistry.remoteDigest(connectionId, target.image);
  } catch {
    // A registry that will not speak is the warning sentence, not a wall: the pull decides.
    digest.value = null;
  }
  checking.value = false;
}

// -- the run ------------------------------------------------------------------------

const running = ref(false);
const phase = ref<UpgradePhase | null>(null);
const outcome = ref<UpgradeOutcome | null>(null);
const outcomeError = ref<string | null>(null);
/** The request the failed run was going to send, kept for the retry that offers to send it again. */
const retryRequest = ref<ContainerCreateRequest | null>(null);

const PHASE_KEYS: Readonly<Record<UpgradePhase, string>> = {
  pulling: "container.upgrade.phase.pulling",
  stopping: "container.upgrade.phase.stopping",
  removing: "container.upgrade.phase.removal",
  creating: "container.upgrade.phase.creating",
  starting: "container.upgrade.phase.starting",
};

/** Where a run stopped, said with the container's name — the phase is the recovery's own answer
 * about whether the old container still exists. */
const FAILURE_KEYS: Readonly<Record<UpgradePhase, string>> = {
  pulling: "container.upgrade.failed.pulling",
  stopping: "container.upgrade.failed.stopping",
  removing: "container.upgrade.failed.removing",
  creating: "container.upgrade.failed.creating",
  starting: "container.upgrade.failed.starting",
};

const phaseText = computed(() => (phase.value === null ? "" : t(PHASE_KEYS[phase.value])));

/** A run may start only when the reading answered and the tag has actually moved (or the registry
 * would not speak, which the warning covers). A current tag has nothing this verb should take. */
const mayRun = computed(() => detail.value !== null && !checking.value && !tagCurrent.value && !running.value);

watch(
  () => props.open,
  (open) => {
    if (!open) {
      phase.value = null;
      outcome.value = null;
      outcomeError.value = null;
      retryRequest.value = null;
    }
  },
);

function close(): void {
  emit("update:open", false);
}

/**
 * The five steps, straight onto the backend: the pull on its own stream (its lines are how the
 * transaction learns the tag had not moved), the three actions on the container's name — which is
 * the one thing that survives the recreation, so the start addresses the replacement — and the
 * create with the request the inspect read back.
 *
 * The pull's listeners are registered before the start command is sent, and the lines that arrive
 * before the answer names the stream are replayed once it has: a pull that finished that fast has
 * already said everything it had to say, and its last line is the one the transaction reads.
 */
function stepsFor(connectionId: string, container: ContainerSummary): UpgradeSteps {
  return {
    async pull(reference, onLine) {
      const pending: { streamId: string; line: string }[] = [];
      const pendingEnds: { streamId: string; error?: string }[] = [];
      let known: string | null = null;
      // A holder rather than a bare variable: the executor runs at once, but a bare `let` reads
      // as null at every use, and the null check would be a lie the compiler cannot see past.
      const settle: { current: ((error?: string) => void) | null } = { current: null };
      const finished = new Promise<void>((resolve, reject) => {
        settle.current = (error) => (error ? reject(new Error(error)) : resolve());
      });
      const unsubscribeLine = await backend.containers.onStreamLine((payload) => {
        if (known === null) {
          pending.push({ streamId: payload.streamId, line: payload.line });
        } else if (payload.streamId === known) {
          onLine(payload.line);
        }
      });
      const unsubscribeEnd = await backend.containers.onStreamEnd((payload) => {
        if (known === null) {
          pendingEnds.push({ streamId: payload.streamId, error: payload.error });
        } else if (payload.streamId === known) {
          settle.current?.(payload.error);
        }
      });
      try {
        const streamId = await backend.containers.imagePull(connectionId, { image: reference });
        // From the await's continuation to the assignment no other callback can run, so the
        // answer and its routing are one step, and no line slips between them.
        known = streamId;
        const replayed = pending.filter((entry) => entry.streamId === streamId);
        pending.length = 0;
        for (const entry of replayed) {
          onLine(entry.line);
        }
        const answered = pendingEnds.find((entry) => entry.streamId === streamId);
        pendingEnds.length = 0;
        if (answered) {
          settle.current?.(answered.error);
        }
        await finished;
      } finally {
        unsubscribeLine();
        unsubscribeEnd();
      }
    },
    async stop() {
      await backend.containers.action(connectionId, container.name, "stop", true);
    },
    async remove() {
      await backend.containers.action(connectionId, container.name, "remove", true);
    },
    async create(request) {
      await backend.containers.create(connectionId, request);
    },
    async start() {
      await backend.containers.action(connectionId, container.name, "start", true);
    },
  };
}

async function run(): Promise<void> {
  const connectionId = props.session.connectionId;
  const target = props.target;
  if (connectionId === null || target === null || detail.value === null || running.value) {
    return;
  }
  running.value = true;
  outcome.value = null;
  outcomeError.value = null;
  retryRequest.value = null;
  const request = upgradeRequestFrom(target, detail.value);
  const answer = await runUpgradeTransaction(stepsFor(connectionId, target), request, {
    onPhase: (value) => {
      phase.value = value;
    },
  });
  outcome.value = answer;
  running.value = false;
  if (answer.kind === "done") {
    toast(t("container.upgrade.done", { name: target.name }), "confirmation");
    void containers.refresh(props.tabId);
    close();
  } else if (answer.kind === "upToDate") {
    toast(t("container.upgrade.upToDateToast", { name: target.name }), "result");
    close();
  } else {
    // A failed run keeps the dialog up: the error is on it, and — past the removal — so is the
    // request the retry sends again.
    outcomeError.value =
      answer.error instanceof Error ? answer.error.message : describe(answer.error, "container_action");
    if (answer.phase === "creating" || answer.phase === "starting") {
      retryRequest.value = request;
    }
  }
}

/** Sends the kept request again, for a run that failed after the removal. */
async function retryCreate(): Promise<void> {
  const connectionId = props.session.connectionId;
  const target = props.target;
  const request = retryRequest.value;
  if (connectionId === null || target === null || request === null || running.value) {
    return;
  }
  running.value = true;
  try {
    await backend.containers.create(connectionId, request);
    await backend.containers.action(connectionId, target.name, "start", true);
    toast(t("container.upgrade.done", { name: target.name }), "confirmation");
    void containers.refresh(props.tabId);
    close();
  } catch (error) {
    outcomeError.value = describe(error, "container_create");
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <!--
    The reading phase of the dialog: what it found, and what it means. The confirm is the shared
    one, because the question underneath is exactly the shape it was drawn for — the action named,
    the consequence in full, the same verb on the button.
  -->
  <ContainerDialog
    :open="open"
    :title="t('container.upgrade.title', { name: target?.name ?? '' })"
    :busy="running"
    @update:open="emit('update:open', $event)"
  >
    <p v-if="checking" class="text-[11px] text-muted-foreground" data-upgrade-checking>
      {{ t("container.upgrade.checking") }}
    </p>
    <template v-else>
      <p class="text-[11px] text-muted-foreground">
        {{ t("container.upgrade.imageLine", { image: target?.image ?? "" }) }}
      </p>
      <p v-if="tagMoved" class="mt-1 text-[11px]" data-upgrade-moved>
        {{ t("container.upgrade.tagMoved") }}
      </p>
      <p v-else-if="tagCurrent" class="mt-1 text-[11px] text-warning" data-upgrade-current>
        {{ t("container.upgrade.tagCurrent") }}
      </p>
      <p v-else class="mt-1 text-[11px] text-warning" data-upgrade-unverified>
        {{ t("container.upgrade.tagUnverified") }}
      </p>
      <p v-if="checkFailure" class="mt-1 text-[11px] text-destructive" data-upgrade-check-failure>
        {{ checkFailure }}
      </p>

      <!-- The consequence, in full — including what survives. -->
      <p class="mt-2 text-[11px]">{{ t("container.upgrade.consequence") }}</p>
      <ul class="mt-1 list-inside list-disc text-[11px] text-muted-foreground">
        <li>{{ t("container.upgrade.kept.mounts") }}</li>
        <li>{{ t("container.upgrade.kept.params") }}</li>
        <li>{{ t("container.upgrade.lost.layer") }}</li>
        <li>{{ t("container.upgrade.lost.downtime") }}</li>
      </ul>
    </template>

    <p v-if="phaseText !== ''" class="mt-2 text-[11px] text-muted-foreground" data-upgrade-phase>
      {{ phaseText }}
    </p>
    <p v-if="outcome?.kind === 'upToDate'" class="mt-2 text-[11px]" data-upgrade-outcome-up-to-date>
      {{ t("container.upgrade.pullSaidCurrent") }}
    </p>
    <div
      v-if="outcome?.kind === 'failed'"
      role="alert"
      class="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5"
      data-upgrade-outcome-failed
    >
      <p class="text-[11px]">{{ t(FAILURE_KEYS[outcome.phase], { name: target?.name ?? "" }) }}</p>
      <p class="mt-0.5 text-[11px] text-destructive select-text">{{ outcomeError }}</p>
    </div>

    <template #footer>
      <WbButton v-if="retryRequest !== null" data-upgrade-retry-create @click="retryCreate()">
        {{ t("container.upgrade.retryCreate") }}
      </WbButton>
      <WbButton @click="close()">{{ t("common.action.cancel") }}</WbButton>
      <WbButton
        v-if="outcome === null || outcome.kind === 'failed'"
        variant="primary"
        :busy="running"
        :disabled="!mayRun"
        data-upgrade-run
        @click="run()"
      >
        {{ t("container.upgrade.run") }}
      </WbButton>
    </template>
  </ContainerDialog>
</template>
