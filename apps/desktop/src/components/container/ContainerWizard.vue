<script setup lang="ts">
/**
 * The create-container wizard, as the reference manager draws it: three steps — the basic
 * settings, the advanced ones in partition cards, and a review — walked with a stepper, with
 * every row checked as it is typed so the engine never sees what it would refuse.
 *
 * It is the desktop window's dialog; the application tab keeps the one-field-per-question dialog
 * it has always had. The two share the engine call and nothing else: the wizard's shape is the
 * reference's, and the mapping to the wire is this file's own. The frame is drawn here rather
 * than on the shared ContainerDialog, because that one carries a fixed width and the reference's
 * wizard is wider; the overlay, the Escape rule and the busy refusal are drawn the same way.
 *
 * What the wire carries decides what the Create button sends. The engine's create request knows
 * the image, the name, the ports, the volumes (with the read-only flag), the environment, the
 * restart policy, the command, and — since the engine grew the seven advanced fields — privileged,
 * the capabilities, the networks, the memory ceiling, the CPU weight preset and the labels. Every
 * one of those is mapped exactly, and every one that is empty stays off the request, because an
 * absent field is the engine's own "unset" and a default is not a value somebody typed. The
 * networks the field offers are the engine's own, listed by the bridge; where the listing is not
 * available the field falls back to names typed by hand.
 *
 * The CPU weight always travels: the form's three steps are the engine's own three presets, and
 * the middle one is a choice (the reference manager's 中, 512 shares) rather than an absence.
 *
 * "Start after creation" is the one promise the wizard keeps by hand: the engine's create answers
 * nothing about what it made, so the refreshed list is diffed against the one before the call —
 * by name when one was given, otherwise by the single container that appeared.
 */
import { Plus, Trash2, TriangleAlert, X } from "@lucide/vue";
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Select, { type SelectOption } from "@/components/ui/Select.vue";
import Switch from "@/components/ui/Switch.vue";
import WbButton from "@/components/ui/WbButton.vue";
import { describeShellError, type DescribedError } from "@/i18n/errors";
import { asShellError } from "@/lib/backend/errors";
import { CONTAINER_ACTIONS, useContainerStore } from "@/stores/container";
import { useNotificationsStore } from "@/stores/notifications";
import type { ContainerCpuWeight } from "@/types/container";
import { IMAGE_TAG_PATTERN } from "./imageTags";

const props = defineProps<{
  open: boolean;
  tabId: string;
  /**
   * The networks the engine knows, when the bridge offers them. An empty list means the source
   * has not landed yet, and the field degrades to names typed by hand.
   */
  networkOptions?: readonly SelectOption[];
  /**
   * What a "clone" ask pre-fills, read once when the wizard opens: the pane inspects the
   * container being copied and hands the fields over here. Null means a plain create.
   */
  prefill?: ContainerClonePrefill | null;
}>();

const emit = defineEmits<{ "update:open": [value: boolean] }>();

const { t } = useI18n();
const containers = useContainerStore();
const notifications = useNotificationsStore();

/** Docker's own name rule: letters, digits, dots, dashes and underscores, at most 64 of them. */
const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

/** The capabilities the reference manager puts one click away, in its own order. */
const COMMON_CAPABILITIES = [
  "SYS_ADMIN",
  "NET_ADMIN",
  "CHOWN",
  "DAC_OVERRIDE",
  "FSETID",
  "KILL",
  "MKNOD",
  "NET_BIND_SERVICE",
  "SETFCAP",
  "SETGID",
  "SETUID",
  "SYS_CHROOT",
] as const;

interface PortRow {
  hostPort: string;
  containerPort: string;
  protocol: "tcp" | "udp";
}

interface VolumeRow {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

interface EnvRow {
  key: string;
  value: string;
}

interface LabelRow {
  name: string;
  value: string;
}

type CpuWeight = "low" | "mid" | "high";

/**
 * What the pane hands the wizard when a container is being cloned: every field the create
 * request carries, read from the container's inspect — the engine-side weights and limits
 * included, via the raw document the detail carries. The name is already suffixed and the
 * start switch already says no: a copy starts unstarted, the way the reference manager copies.
 */
export interface ContainerClonePrefill {
  readonly name: string;
  readonly image: string;
  readonly autostart: boolean;
  readonly startNow: boolean;
  readonly privileged: boolean;
  readonly command: string;
  readonly ports: readonly { hostPort: string; containerPort: string; protocol: "tcp" | "udp" }[];
  readonly volumes: readonly { hostPath: string; containerPath: string; readOnly: boolean }[];
  readonly env: readonly { key: string; value: string }[];
  readonly labels: readonly { name: string; value: string }[];
  readonly networks: readonly string[];
  readonly capabilities: readonly string[];
  readonly cpuWeight: CpuWeight;
  /** The memory limit in megabytes, or null when the source container had none. */
  readonly memoryLimitMb: string | null;
}

const form = reactive({
  image: "",
  name: "",
  autostart: false,
  startNow: true,
  privileged: false,
  ports: [] as PortRow[],
  volumes: [] as VolumeRow[],
  env: [] as EnvRow[],
  labels: [] as LabelRow[],
  networks: [] as string[],
  networksText: "",
  capabilities: [] as string[],
  command: "",
  cpuWeight: "mid" as CpuWeight,
  memoryLimited: false,
  memoryLimitMb: "",
});

const step = ref<1 | 2 | 3>(1);
const reached = ref<1 | 2 | 3>(1);
const attemptedBasic = ref(false);
const busy = ref(false);
const failure = ref<DescribedError | null>(null);

const protocolOptions = [
  { value: "tcp", label: "tcp" },
  { value: "udp", label: "udp" },
];

const cpuOptions = computed(() => [
  { value: "low", label: t("container.wizard.cpuLow") },
  { value: "mid", label: t("container.wizard.cpuMid") },
  { value: "high", label: t("container.wizard.cpuHigh") },
]);

const volumeModeOptions = computed(() => [
  { value: "rw", label: t("container.wizard.volumeRw") },
  { value: "ro", label: t("container.wizard.volumeRo") },
]);

/** A field too long for one row is read back with the same words that wrote it. */
const steps = computed(() => [
  { id: 1 as const, label: t("container.wizard.stepBasic") },
  { id: 2 as const, label: t("container.wizard.stepAdvanced") },
  { id: 3 as const, label: t("container.wizard.stepReview") },
]);

watch(
  () => props.open,
  (open) => {
    if (!open) {
      return;
    }
    form.image = "";
    form.name = "";
    form.autostart = false;
    form.startNow = true;
    form.privileged = false;
    form.ports = [];
    form.volumes = [];
    form.env = [];
    form.labels = [];
    form.networks = [];
    form.networksText = "";
    form.capabilities = [];
    form.command = "";
    form.cpuWeight = "mid";
    form.memoryLimited = false;
    form.memoryLimitMb = "";
    step.value = 1;
    reached.value = 1;
    attemptedBasic.value = false;
    busy.value = false;
    failure.value = null;
    // A clone ask lands after the reset: what was inspected writes itself over the blank form.
    // immediate: the very first open of a mounted wizard answers to this watch too.
    const prefill = props.prefill;
    if (prefill !== undefined && prefill !== null) {
      form.image = prefill.image;
      form.name = prefill.name;
      form.autostart = prefill.autostart;
      form.startNow = prefill.startNow;
      form.privileged = prefill.privileged;
      form.ports = prefill.ports.map((row) => ({ ...row }));
      form.volumes = prefill.volumes.map((row) => ({ ...row }));
      form.env = prefill.env.map((row) => ({ ...row }));
      form.labels = prefill.labels.map((row) => ({ ...row }));
      form.networks = [...prefill.networks];
      form.capabilities = [...prefill.capabilities];
      form.command = prefill.command;
      form.cpuWeight = prefill.cpuWeight;
      if (prefill.memoryLimitMb !== null) {
        form.memoryLimited = true;
        form.memoryLimitMb = prefill.memoryLimitMb;
      }
    }
  },
  { immediate: true },
);

// -- what each field says while it is being typed ---------------------------------

/**
 * The tag half of a `name:tag` reference, when there is one worth checking. The last colon splits
 * it: a registry port lives before the slash, so a tail that carries one is a repository, not a
 * tag, and is the engine's business rather than this form's.
 */
function imageTagOf(image: string): string | null {
  const at = image.lastIndexOf(":");
  if (at <= 0 || at === image.length - 1) {
    return null;
  }
  const tail = image.slice(at + 1).trim();
  return tail.includes("/") ? null : tail;
}

const imageGrammarProblem = computed(() => {
  const image = form.image.trim();
  if (image === "") {
    return null;
  }
  const tag = imageTagOf(image);
  if (tag !== null && !IMAGE_TAG_PATTERN.test(tag)) {
    return t("container.desktop.images.tagInvalid");
  }
  return null;
});

const nameProblem = computed(() => {
  const name = form.name.trim();
  return name === "" || CONTAINER_NAME_PATTERN.test(name) ? null : t("container.wizard.nameInvalid");
});

const basicGate = computed(
  () => form.image.trim() === "" || imageGrammarProblem.value !== null || nameProblem.value !== null,
);

/** Whether a port row means anything: half a row is the row's own mistake, not a default. */
function portRowProblem(row: PortRow): string | null {
  const host = row.hostPort.trim();
  const container = row.containerPort.trim();
  if (host === "" && container === "") {
    return null;
  }
  for (const side of [host, container]) {
    if (!/^\d+$/.test(side) || Number(side) < 1 || Number(side) > 65535) {
      return t("container.wizard.portInvalid");
    }
  }
  return null;
}

const portRowsProblem = computed(() => {
  for (const row of form.ports) {
    const problem = portRowProblem(row);
    if (problem) {
      return problem;
    }
  }
  const seen = new Map<string, string>();
  for (const row of form.ports) {
    if (row.hostPort.trim() === "") {
      continue;
    }
    const key = `${row.hostPort.trim()}/${row.protocol}`;
    const previous = seen.get(key);
    if (previous !== undefined) {
      return t("container.wizard.portDuplicate", { port: row.hostPort.trim(), protocol: row.protocol });
    }
    seen.set(key, row.containerPort.trim());
  }
  return null;
});

function volumeRowProblem(row: VolumeRow): string | null {
  return row.hostPath.trim() === "" || row.containerPath.trim() === "" ? t("container.wizard.volumeInvalid") : null;
}

const volumeRowsProblem = computed(() => {
  for (const row of form.volumes) {
    if (row.hostPath.trim() === "" && row.containerPath.trim() === "") {
      continue;
    }
    const problem = volumeRowProblem(row);
    if (problem) {
      return problem;
    }
  }
  return null;
});

function envRowProblem(row: EnvRow): string | null {
  if (row.key.trim() === "" && row.value.trim() === "") {
    return null;
  }
  return row.key.trim() === "" || row.key.includes("=") ? t("container.wizard.envInvalid") : null;
}

const envRowsProblem = computed(() => {
  for (const row of form.env) {
    const problem = envRowProblem(row);
    if (problem) {
      return problem;
    }
  }
  return null;
});

/**
 * A label row means something when it has a name; the value may be empty, because a label marks a
 * container whether or not it carries a reading. The name cannot carry `=` — the wire is a map,
 * and a key with a separator in it would be a different key than the one being typed.
 */
function labelRowProblem(row: LabelRow): string | null {
  if (row.name.trim() === "" && row.value.trim() === "") {
    return null;
  }
  return row.name.trim() === "" || row.name.includes("=") ? t("container.wizard.labelInvalid") : null;
}

const labelRowsProblem = computed(() => {
  for (const row of form.labels) {
    const problem = labelRowProblem(row);
    if (problem) {
      return problem;
    }
  }
  return null;
});

const memoryProblem = computed(() => {
  if (!form.memoryLimited) {
    return null;
  }
  const limit = form.memoryLimitMb.trim();
  return /^\d+$/.test(limit) && Number(limit) > 0 ? null : t("container.wizard.memoryInvalid");
});

const advancedGate = computed(
  () =>
    portRowsProblem.value !== null ||
    volumeRowsProblem.value !== null ||
    envRowsProblem.value !== null ||
    labelRowsProblem.value !== null ||
    memoryProblem.value !== null,
);

// -- the walk ----------------------------------------------------------------------

function gotoStep(target: 1 | 2 | 3): void {
  if (target > reached.value) {
    return;
  }
  step.value = target;
}

function nextFromBasic(): void {
  attemptedBasic.value = true;
  if (basicGate.value) {
    return;
  }
  step.value = 2;
  reached.value = 2;
}

function nextFromAdvanced(): void {
  if (advancedGate.value) {
    return;
  }
  step.value = 3;
  reached.value = 3;
}

// -- the review --------------------------------------------------------------------

const networkNames = computed<string[]>(() => {
  if ((props.networkOptions?.length ?? 0) > 0) {
    return [...form.networks];
  }
  return form.networksText
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
});

interface ReviewRow {
  label: string;
  value: string;
}

const reviewRows = computed<ReviewRow[]>(() => {
  const rows: ReviewRow[] = [];
  rows.push({ label: t("container.create.image"), value: form.image.trim() });
  rows.push({
    label: t("container.create.name"),
    value: form.name.trim() === "" ? t("container.wizard.reviewAuto") : form.name.trim(),
  });
  rows.push({
    label: t("container.wizard.autostart"),
    value: form.autostart ? t("container.wizard.reviewOn") : t("container.wizard.reviewOff"),
  });
  rows.push({
    label: t("container.wizard.startNow"),
    value: form.startNow ? t("container.wizard.reviewOn") : t("container.wizard.reviewOff"),
  });
  rows.push({
    label: t("container.wizard.privileged"),
    value: form.privileged ? t("container.wizard.reviewOn") : t("container.wizard.reviewOff"),
  });

  const ports = form.ports
    .filter((row) => portRowProblem(row) === null && (row.hostPort.trim() !== "" || row.containerPort.trim() !== ""))
    .map((row) => `${row.hostPort.trim()} → ${row.containerPort.trim()}/${row.protocol}`);
  if (ports.length > 0) {
    rows.push({ label: t("container.create.ports"), value: ports.join("  ") });
  }

  const volumes = form.volumes
    .filter((row) => volumeRowProblem(row) === null && (row.hostPath.trim() !== "" || row.containerPath.trim() !== ""))
    .map((row) => `${row.hostPath.trim()} → ${row.containerPath.trim()} (${row.readOnly ? "ro" : "rw"})`);
  if (volumes.length > 0) {
    rows.push({ label: t("container.create.volumes"), value: volumes.join("  ") });
  }

  const env = form.env
    .filter((row) => envRowProblem(row) === null && row.key.trim() !== "")
    .map((row) => `${row.key.trim()}=${row.value.trim()}`);
  if (env.length > 0) {
    rows.push({ label: t("container.create.env"), value: env.join("  ") });
  }

  const labels = form.labels
    .filter((row) => labelRowProblem(row) === null && row.name.trim() !== "")
    .map((row) => `${row.name.trim()}=${row.value.trim()}`);
  if (labels.length > 0) {
    rows.push({ label: t("container.wizard.labels"), value: labels.join("  ") });
  }

  const networks = networkNames.value;
  if (networks.length > 0) {
    rows.push({ label: t("container.wizard.networks"), value: networks.join(", ") });
  }

  if (form.capabilities.length > 0) {
    rows.push({ label: t("container.wizard.capabilities"), value: form.capabilities.join(", ") });
  }

  if (form.command.trim() !== "") {
    rows.push({ label: t("container.create.command"), value: form.command.trim() });
  }

  rows.push({
    label: t("container.wizard.cpuWeight"),
    value: cpuOptions.value.find((option) => option.value === form.cpuWeight)?.label ?? form.cpuWeight,
  });

  rows.push({
    label: t("container.wizard.memoryLimit"),
    value: form.memoryLimited ? `${form.memoryLimitMb.trim()} MB` : t("container.wizard.reviewOff"),
  });
  return rows;
});

// -- the wire ----------------------------------------------------------------------

/** The ports as the wire carries them: two numbers and a protocol; half-filled rows never travel. */
function buildPorts(): { hostPort: number; containerPort: number; protocol: string }[] {
  return form.ports
    .filter((row) => row.hostPort.trim() !== "" && row.containerPort.trim() !== "")
    .map((row) => ({
      hostPort: Number(row.hostPort.trim()),
      containerPort: Number(row.containerPort.trim()),
      protocol: row.protocol,
    }));
}

/** A volume as the wire carries it: two paths, and the read-only flag only when it was asked for. */
function buildVolumes(): { source: string; destination: string; readOnly?: boolean }[] {
  return form.volumes
    .filter((row) => row.hostPath.trim() !== "" && row.containerPath.trim() !== "")
    .map((row) => ({
      source: row.hostPath.trim(),
      destination: row.containerPath.trim(),
      ...(row.readOnly ? { readOnly: true } : {}),
    }));
}

function buildEnv(): string[] {
  return form.env
    .filter((row) => row.key.trim() !== "" && !row.key.includes("="))
    .map((row) => `${row.key.trim()}=${row.value.trim()}`);
}

/** The labels as the wire carries them: a map, which is why a name may be written only once. */
function buildLabels(): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const row of form.labels) {
    const name = row.name.trim();
    if (name !== "" && !name.includes("=")) {
      labels[name] = row.value.trim();
    }
  }
  return labels;
}

/**
 * The request the engine's create command reads. Everything the wire carries is here; a field the
 * form leaves empty stays off the request, because an absent field is the engine's own "unset" and
 * a default is not a value somebody typed.
 */
function buildRequest() {
  const image = form.image.trim();
  const name = form.name.trim();
  const command = form.command.trim();
  const ports = buildPorts();
  const volumes = buildVolumes();
  const env = buildEnv();
  const labels = buildLabels();
  const networks = networkNames.value;
  const memoryLimitMb = form.memoryLimited && memoryProblem.value === null ? Number(form.memoryLimitMb.trim()) : null;
  return {
    image,
    ...(name !== "" ? { name } : {}),
    ...(ports.length > 0 ? { ports } : {}),
    ...(volumes.length > 0 ? { volumes } : {}),
    ...(env.length > 0 ? { env } : {}),
    ...(labels && Object.keys(labels).length > 0 ? { labels } : {}),
    restartPolicy: form.autostart ? "always" : "no",
    ...(command !== "" ? { command } : {}),
    ...(form.privileged ? { privileged: true } : {}),
    ...(form.capabilities.length > 0 ? { capabilities: [...form.capabilities] } : {}),
    ...(networks.length > 0 ? { networks } : {}),
    ...(memoryLimitMb !== null ? { memoryLimitMb } : {}),
    // The three steps are the engine's own presets, and the middle one is a choice, not an
    // absence: the reference manager's 中 carries 512 shares by explicit selection.
    cpuWeight: (form.cpuWeight === "mid" ? "normal" : form.cpuWeight) as ContainerCpuWeight,
  };
}

/**
 * The container the engine just made, found in the refreshed list: by name when one was asked
 * for, otherwise as the one container that was not there before. Nothing found means nothing to
 * start — the list is still the place to see it.
 */
function findCreated(
  list: readonly { id: string; name: string }[],
  before: ReadonlySet<string>,
): { id: string; name: string } | undefined {
  const wanted = form.name.trim();
  if (wanted !== "") {
    const named = list.find((entry) => entry.name === wanted);
    if (named) {
      return named;
    }
  }
  const added = list.filter((entry) => !before.has(entry.id));
  return added.length === 1 ? added[0] : undefined;
}

async function submit(): Promise<void> {
  if (busy.value) {
    return;
  }
  const session = containers.sessionFor(props.tabId);
  if (!session?.connectionId) {
    return;
  }
  busy.value = true;
  failure.value = null;
  try {
    const before = new Set(session.containers.map((entry) => entry.id));
    await containers.create(props.tabId, buildRequest());
    const after = containers.sessionFor(props.tabId);
    const created = after ? findCreated(after.containers, before) : undefined;
    let started = false;
    if (form.startNow && created) {
      try {
        await containers.action(props.tabId, created.id, CONTAINER_ACTIONS.start, false);
        started = true;
      } catch {
        // The store kept the envelope; the pane's banner shows it. The create itself stands.
      }
    }
    notifications.push({
      source: "container",
      titleKey: started ? "container.wizard.notice.createdStarted" : "container.wizard.notice.created",
      params: { name: created?.name ?? displayName() },
    });
    emit("update:open", false);
  } catch (error) {
    failure.value = describeShellError(translate, asShellError(error, "container_create"));
  } finally {
    busy.value = false;
  }
}

function displayName(): string {
  return form.name.trim() === "" ? form.image.trim() : form.name.trim();
}

function translate(key: string, params?: Record<string, string>): string {
  return params ? t(key, params) : t(key);
}

// -- row helpers -------------------------------------------------------------------

function addPort(): void {
  form.ports.push({ hostPort: "", containerPort: "", protocol: "tcp" });
}

function addVolume(): void {
  form.volumes.push({ hostPath: "", containerPath: "", readOnly: false });
}

function addEnv(): void {
  form.env.push({ key: "", value: "" });
}

function addLabel(): void {
  form.labels.push({ name: "", value: "" });
}

function toggleNetwork(value: string): void {
  const at = form.networks.indexOf(value);
  if (at >= 0) {
    form.networks.splice(at, 1);
  } else {
    form.networks.push(value);
  }
}

function toggleCapability(name: string): void {
  const at = form.capabilities.indexOf(name);
  if (at >= 0) {
    form.capabilities.splice(at, 1);
  } else {
    form.capabilities.push(name);
  }
}

const hasNetworkOptions = computed(() => (props.networkOptions?.length ?? 0) > 0);
</script>

<template>
  <DialogRoot :open="props.open" @update:open="(value: boolean) => emit('update:open', value)">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-overlay" />
      <DialogContent
        class="fixed top-1/2 left-1/2 z-50 flex max-h-[min(86vh,44rem)] w-[min(42.5rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-card shadow-xl select-none focus:outline-none"
        :aria-describedby="undefined"
        @interact-outside="busy && $event.preventDefault()"
        @escape-key-down="busy && $event.preventDefault()"
      >
        <header class="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <DialogTitle class="min-w-0 truncate text-sm font-medium">{{ t("container.wizard.title") }}</DialogTitle>
          <button
            type="button"
            class="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            :title="t('common.action.close')"
            :aria-label="t('common.action.close')"
            :disabled="busy"
            @click="emit('update:open', false)"
          >
            <X :size="12" />
          </button>
        </header>

        <!--
          The stepper: the step being walked, the ones already answered, and the ones still ahead.
          A finished step may be revisited; an ahead one is only reached by walking to it, so a
          review is never read before the fields behind it were answered.
        -->
        <nav
          class="flex shrink-0 items-center gap-1 border-b border-border px-4 py-2"
          :aria-label="t('container.wizard.title')"
        >
          <template v-for="(entry, index) in steps" :key="entry.id">
            <span v-if="index > 0" class="mx-1 h-px w-4 shrink-0 bg-border" aria-hidden="true"></span>
            <button
              type="button"
              class="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors"
              :class="
                step === entry.id
                  ? 'bg-accent text-foreground'
                  : entry.id < step
                    ? 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                    : 'text-muted-foreground'
              "
              :data-wizard-step="entry.id"
              :aria-current="step === entry.id ? 'step' : undefined"
              :disabled="entry.id > reached"
              @click="gotoStep(entry.id)"
            >
              <span
                class="grid size-4 shrink-0 place-items-center rounded-full border text-[10px]"
                :class="step === entry.id ? 'border-primary bg-primary text-primary-foreground' : 'border-border'"
              >
                {{ entry.id }}
              </span>
              <span class="min-w-0 truncate">{{ entry.label }}</span>
            </button>
          </template>
        </nav>

        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3 select-text">
          <!-- Step 1: what the container is. -->
          <div v-if="step === 1" class="flex flex-col gap-3" data-wizard-basic>
            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-muted-foreground">{{ t("container.create.image") }}</span>
              <input
                v-model="form.image"
                type="text"
                spellcheck="false"
                data-wizard-image
                class="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
                :class="imageGrammarProblem ? 'border-destructive' : ''"
                :placeholder="t('container.create.imagePlaceholder')"
                :aria-label="t('container.create.image')"
              />
              <span v-if="imageGrammarProblem" class="text-[10px] text-destructive">{{ imageGrammarProblem }}</span>
              <span v-else-if="attemptedBasic && form.image.trim() === ''" class="text-[10px] text-destructive">
                {{ t("container.create.imageRequired") }}
              </span>
              <span v-else class="text-[10px] text-muted-foreground">{{ t("container.wizard.imageHint") }}</span>
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-[11px] text-muted-foreground">{{ t("container.create.name") }}</span>
              <input
                v-model="form.name"
                type="text"
                spellcheck="false"
                data-wizard-name
                class="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
                :class="nameProblem ? 'border-destructive' : ''"
                :aria-label="t('container.create.name')"
              />
              <span v-if="nameProblem" class="text-[10px] text-destructive">{{ nameProblem }}</span>
              <span v-else class="text-[10px] text-muted-foreground">{{ t("container.wizard.nameHint") }}</span>
            </label>

            <div class="flex items-center justify-between gap-2">
              <span class="min-w-0">
                <span class="block text-[11px]">{{ t("container.wizard.autostart") }}</span>
                <span class="block text-[10px] text-muted-foreground">{{ t("container.wizard.autostartHint") }}</span>
              </span>
              <Switch v-model="form.autostart" :aria-label="t('container.wizard.autostart')" data-wizard-autostart />
            </div>

            <div class="flex items-center justify-between gap-2">
              <span class="min-w-0 text-[11px]">{{ t("container.wizard.startNow") }}</span>
              <Switch v-model="form.startNow" :aria-label="t('container.wizard.startNow')" data-wizard-start-now />
            </div>

            <div class="flex items-center justify-between gap-2">
              <span class="min-w-0">
                <span class="block text-[11px]">{{ t("container.wizard.privileged") }}</span>
                <span class="mt-0.5 flex items-center gap-1 text-[10px]" style="color: var(--warning)">
                  <TriangleAlert :size="10" class="shrink-0" aria-hidden="true" />
                  {{ t("container.wizard.privilegedWarning") }}
                </span>
              </span>
              <Switch v-model="form.privileged" :aria-label="t('container.wizard.privileged')" data-wizard-privileged />
            </div>
          </div>

          <!-- Step 2: how it runs, in the partition cards the reference draws. -->
          <div v-else-if="step === 2" class="flex flex-col gap-3" data-wizard-advanced>
            <section class="rounded-lg border border-border p-3">
              <h4 class="mb-2 text-[11px] font-medium text-muted-foreground">{{ t("container.create.ports") }}</h4>
              <div class="flex flex-col gap-1.5">
                <div v-for="(row, index) in form.ports" :key="index" class="flex items-center gap-1.5">
                  <input
                    v-model="row.hostPort"
                    type="text"
                    inputmode="numeric"
                    data-wizard-port-host
                    class="w-20 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
                    :aria-label="t('container.create.portHost')"
                    :placeholder="t('container.create.portHost')"
                  />
                  <span class="text-[11px] text-muted-foreground">→</span>
                  <input
                    v-model="row.containerPort"
                    type="text"
                    inputmode="numeric"
                    data-wizard-port-container
                    class="w-20 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
                    :aria-label="t('container.create.portContainer')"
                    :placeholder="t('container.create.portContainer')"
                  />
                  <Select
                    :model-value="row.protocol"
                    :options="protocolOptions"
                    size="compact"
                    class="w-16"
                    :aria-label="t('container.create.ports')"
                    @update:model-value="(value: string) => (row.protocol = value === 'udp' ? 'udp' : 'tcp')"
                  />
                  <button
                    type="button"
                    class="grid size-5 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    :title="t('container.create.removeRow')"
                    :aria-label="t('container.create.removeRow')"
                    @click="form.ports.splice(index, 1)"
                  >
                    <Trash2 :size="11" />
                  </button>
                </div>
                <button
                  type="button"
                  class="flex w-fit items-center gap-1 rounded-sm px-1 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  data-wizard-add-port
                  @click="addPort()"
                >
                  <Plus :size="10" />
                  {{ t("container.create.addRow") }}
                </button>
                <span v-if="portRowsProblem" class="text-[10px] text-destructive">{{ portRowsProblem }}</span>
              </div>
            </section>

            <section class="rounded-lg border border-border p-3">
              <h4 class="mb-2 text-[11px] font-medium text-muted-foreground">{{ t("container.create.volumes") }}</h4>
              <div class="flex flex-col gap-1.5">
                <div v-for="(row, index) in form.volumes" :key="index" class="flex items-center gap-1.5">
                  <input
                    v-model="row.hostPath"
                    type="text"
                    spellcheck="false"
                    data-wizard-volume-host
                    class="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
                    :aria-label="t('container.wizard.volumeHost')"
                    :placeholder="t('container.wizard.volumeHost')"
                  />
                  <span class="text-[11px] text-muted-foreground">→</span>
                  <input
                    v-model="row.containerPath"
                    type="text"
                    spellcheck="false"
                    data-wizard-volume-container
                    class="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
                    :aria-label="t('container.wizard.volumeContainer')"
                    :placeholder="t('container.wizard.volumeContainer')"
                  />
                  <Select
                    :model-value="row.readOnly ? 'ro' : 'rw'"
                    :options="volumeModeOptions"
                    size="compact"
                    class="w-20"
                    :aria-label="t('container.wizard.volumeMode')"
                    @update:model-value="(value: string) => (row.readOnly = value === 'ro')"
                  />
                  <button
                    type="button"
                    class="grid size-5 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    :title="t('container.create.removeRow')"
                    :aria-label="t('container.create.removeRow')"
                    @click="form.volumes.splice(index, 1)"
                  >
                    <Trash2 :size="11" />
                  </button>
                </div>
                <button
                  type="button"
                  class="flex w-fit items-center gap-1 rounded-sm px-1 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  data-wizard-add-volume
                  @click="addVolume()"
                >
                  <Plus :size="10" />
                  {{ t("container.create.addRow") }}
                </button>
                <span v-if="volumeRowsProblem" class="text-[10px] text-destructive">{{ volumeRowsProblem }}</span>
              </div>
            </section>

            <section class="rounded-lg border border-border p-3">
              <h4 class="mb-2 text-[11px] font-medium text-muted-foreground">{{ t("container.create.env") }}</h4>
              <div class="flex flex-col gap-1.5">
                <div v-for="(row, index) in form.env" :key="index" class="flex items-center gap-1.5">
                  <input
                    v-model="row.key"
                    type="text"
                    spellcheck="false"
                    data-wizard-env-key
                    class="w-40 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
                    :aria-label="t('container.wizard.envKey')"
                    :placeholder="t('container.wizard.envKey')"
                  />
                  <span class="text-[11px] text-muted-foreground">=</span>
                  <input
                    v-model="row.value"
                    type="text"
                    spellcheck="false"
                    data-wizard-env-value
                    class="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
                    :aria-label="t('container.wizard.envValue')"
                    :placeholder="t('container.wizard.envValue')"
                  />
                  <button
                    type="button"
                    class="grid size-5 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    :title="t('container.create.removeRow')"
                    :aria-label="t('container.create.removeRow')"
                    @click="form.env.splice(index, 1)"
                  >
                    <Trash2 :size="11" />
                  </button>
                </div>
                <button
                  type="button"
                  class="flex w-fit items-center gap-1 rounded-sm px-1 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  data-wizard-add-env
                  @click="addEnv()"
                >
                  <Plus :size="10" />
                  {{ t("container.create.addRow") }}
                </button>
                <span v-if="envRowsProblem" class="text-[10px] text-destructive">{{ envRowsProblem }}</span>
              </div>
            </section>

            <!--
              Labels: the annotations a container carries, one name and value to a row. The wire is
              a map, so a name written twice is the same name written over — the row refuses a name
              that is already on the list rather than letting the last one win silently.
            -->
            <section class="rounded-lg border border-border p-3">
              <h4 class="mb-2 text-[11px] font-medium text-muted-foreground">{{ t("container.wizard.labels") }}</h4>
              <div class="flex flex-col gap-1.5">
                <div v-for="(row, index) in form.labels" :key="index" class="flex items-center gap-1.5">
                  <input
                    v-model="row.name"
                    type="text"
                    spellcheck="false"
                    data-wizard-label-name
                    class="w-40 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
                    :aria-label="t('container.wizard.labelName')"
                    :placeholder="t('container.wizard.labelName')"
                  />
                  <span class="text-[11px] text-muted-foreground">=</span>
                  <input
                    v-model="row.value"
                    type="text"
                    spellcheck="false"
                    data-wizard-label-value
                    class="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
                    :aria-label="t('container.wizard.labelValue')"
                    :placeholder="t('container.wizard.labelValue')"
                  />
                  <button
                    type="button"
                    class="grid size-5 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    :title="t('container.create.removeRow')"
                    :aria-label="t('container.create.removeRow')"
                    @click="form.labels.splice(index, 1)"
                  >
                    <Trash2 :size="11" />
                  </button>
                </div>
                <button
                  type="button"
                  class="flex w-fit items-center gap-1 rounded-sm px-1 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  data-wizard-add-label
                  @click="addLabel()"
                >
                  <Plus :size="10" />
                  {{ t("container.create.addRow") }}
                </button>
                <span v-if="labelRowsProblem" class="text-[10px] text-destructive">{{ labelRowsProblem }}</span>
              </div>
            </section>

            <section class="rounded-lg border border-border p-3">
              <h4 class="mb-2 text-[11px] font-medium text-muted-foreground">{{ t("container.wizard.networks") }}</h4>
              <div v-if="hasNetworkOptions" class="flex flex-wrap gap-1.5">
                <label
                  v-for="option in props.networkOptions"
                  :key="option.value"
                  class="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] transition-colors hover:bg-accent/50"
                >
                  <input
                    type="checkbox"
                    class="size-3 accent-[var(--primary)]"
                    :checked="form.networks.includes(option.value)"
                    :aria-label="option.label"
                    @change="toggleNetwork(option.value)"
                  />
                  <span class="font-mono">{{ option.label }}</span>
                </label>
              </div>
              <div v-else class="flex flex-col gap-1">
                <input
                  v-model="form.networksText"
                  type="text"
                  spellcheck="false"
                  data-wizard-networks-text
                  class="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
                  :placeholder="t('container.wizard.networksPlaceholder')"
                  :aria-label="t('container.wizard.networks')"
                />
                <span class="text-[10px] text-muted-foreground">{{ t("container.wizard.networksHint") }}</span>
              </div>
            </section>

            <section class="rounded-lg border border-border p-3">
              <h4 class="mb-2 text-[11px] font-medium text-muted-foreground">
                {{ t("container.wizard.capabilities") }}
              </h4>
              <div class="flex flex-wrap gap-1.5">
                <label
                  v-for="name in COMMON_CAPABILITIES"
                  :key="name"
                  class="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 font-mono text-[11px] transition-colors hover:bg-accent/50"
                >
                  <input
                    type="checkbox"
                    class="size-3 accent-[var(--primary)]"
                    :checked="form.capabilities.includes(name)"
                    :aria-label="name"
                    @change="toggleCapability(name)"
                  />
                  {{ name }}
                </label>
              </div>
            </section>

            <section class="rounded-lg border border-border p-3">
              <h4 class="mb-2 text-[11px] font-medium text-muted-foreground">{{ t("container.create.command") }}</h4>
              <input
                v-model="form.command"
                type="text"
                spellcheck="false"
                data-wizard-command
                class="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
                :aria-label="t('container.create.command')"
              />
              <p class="mt-1 text-[10px] text-muted-foreground">{{ t("container.wizard.commandHint") }}</p>
            </section>

            <section class="rounded-lg border border-border p-3">
              <h4 class="mb-2 text-[11px] font-medium text-muted-foreground">{{ t("container.wizard.resources") }}</h4>
              <div class="flex items-center justify-between gap-2">
                <span class="text-[11px]">{{ t("container.wizard.cpuWeight") }}</span>
                <Select
                  v-model="form.cpuWeight"
                  :options="cpuOptions"
                  size="compact"
                  class="w-24"
                  :aria-label="t('container.wizard.cpuWeight')"
                  data-wizard-cpu
                />
              </div>
              <div class="mt-2 flex items-center justify-between gap-2">
                <span class="text-[11px]">{{ t("container.wizard.memoryLimit") }}</span>
                <Switch
                  v-model="form.memoryLimited"
                  :aria-label="t('container.wizard.memoryLimit')"
                  data-wizard-memory-enabled
                />
              </div>
              <div v-if="form.memoryLimited" class="mt-2 flex items-center gap-1.5">
                <input
                  v-model="form.memoryLimitMb"
                  type="text"
                  inputmode="numeric"
                  data-wizard-memory-limit
                  class="w-24 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
                  :class="memoryProblem ? 'border-destructive' : ''"
                  :aria-label="t('container.wizard.memoryLimitMb')"
                  placeholder="512"
                />
                <span class="text-[10px] text-muted-foreground">MB</span>
              </div>
              <span v-if="memoryProblem" class="mt-1 block text-[10px] text-destructive">{{ memoryProblem }}</span>
            </section>
          </div>

          <!-- Step 3: everything the form holds, read back before it goes anywhere. -->
          <div v-else class="flex flex-col gap-2" data-wizard-review>
            <dl class="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
              <div
                v-for="row in reviewRows"
                :key="row.label"
                class="flex items-baseline gap-3 px-3 py-1.5"
                data-wizard-review-row
              >
                <dt class="w-28 shrink-0 text-[11px] text-muted-foreground">{{ row.label }}</dt>
                <dd class="min-w-0 flex-1 break-all font-mono text-[11px]">{{ row.value }}</dd>
              </div>
            </dl>
            <p v-if="failure" role="alert" class="text-[11px] text-destructive select-text">
              {{ failure.message }}
              <span class="block font-mono text-[10px] text-muted-foreground">{{ failure.code }}</span>
            </p>
          </div>
        </div>

        <footer
          class="flex shrink-0 items-center justify-end gap-2 rounded-b-lg border-t border-border bg-muted/40 px-4 py-2.5"
        >
          <WbButton data-wizard-cancel :disabled="busy" @click="emit('update:open', false)">
            {{ t("common.action.cancel") }}
          </WbButton>
          <WbButton v-if="step > 1" data-wizard-back :disabled="busy" @click="gotoStep((step - 1) as 1 | 2)">
            {{ t("container.wizard.back") }}
          </WbButton>
          <WbButton v-if="step === 1" data-wizard-next @click="nextFromBasic()">
            {{ t("container.wizard.next") }}
          </WbButton>
          <WbButton v-else-if="step === 2" data-wizard-next :disabled="advancedGate" @click="nextFromAdvanced()">
            {{ t("container.wizard.toReview") }}
          </WbButton>
          <WbButton v-else variant="primary" data-wizard-create :busy="busy" @click="submit()">
            {{ busy ? t("container.wizard.creating") : t("container.wizard.create") }}
          </WbButton>
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
