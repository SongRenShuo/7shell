<script setup lang="ts">
/**
 * The update's gate: five questions, asked one at a time, each answerable with "no".
 *
 * The order is the order the questions matter in. What runs on this image first — because the
 * count is the fact the rest of the list hangs on. What the data does second — because "update" on
 * a container manager is one word away from losing a volume somebody did not name. Where the pull
 * would come from third — the mirrors the daemon consults, read when the dialog opened, not from a
 * card that may be stale. What cannot be taken back fourth — the dialog walks away once the pull
 * starts, and the panel below the list is where the pull then lives. What failure looks like
 * fifth — the sentence to read if the row in that panel turns red.
 *
 * Every step offers the way out: "Back" within the list, "Cancel" on all of them. Nothing is sent
 * to the engine from here — the confirm is a flag to the page that owns the pull, and the page
 * applies its own guard against a second update of the same image before it starts one.
 */
import { LoaderCircle } from "@lucide/vue";
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import ContainerDialog from "@/components/container/ContainerDialog.vue";
import WbButton from "@/components/ui/WbButton.vue";
import { backend } from "@/lib/backend/api";
import type { ContainerRegistrySettings, ContainerSummary } from "@/types/container";

const props = defineProps<{
  open: boolean;
  /** The image the update would pull, as the engine reads it. */
  reference: string;
  /** The containers the engine lists on this image, as the list page filtered them. */
  affected: readonly ContainerSummary[];
  connectionId: string | null;
  /** The page is carrying the confirm to the pull; the dialog waits and refuses to be dismissed. */
  busy: boolean;
}>();

const emit = defineEmits<{
  confirm: [];
  "update:open": [value: boolean];
}>();

const { t } = useI18n();

const STEPS = 5;
const step = ref(1);

// -- the mirrors, read when the dialog opens -------------------------------------

const mirrorsLoading = ref(false);
const mirrorsFailed = ref(false);
const settings = ref<ContainerRegistrySettings | null>(null);
let mirrorsGeneration = 0;

async function loadMirrors(): Promise<void> {
  const connectionId = props.connectionId;
  const generation = ++mirrorsGeneration;
  settings.value = null;
  mirrorsFailed.value = false;
  if (connectionId === null) {
    mirrorsFailed.value = true;
    return;
  }
  mirrorsLoading.value = true;
  try {
    const answer = await backend.dockerRegistry.info(connectionId);
    if (generation === mirrorsGeneration) {
      settings.value = answer;
    }
  } catch {
    // The card on the overview may say what this one could not read; the step says so honestly.
    if (generation === mirrorsGeneration) {
      mirrorsFailed.value = true;
    }
  } finally {
    if (generation === mirrorsGeneration) {
      mirrorsLoading.value = false;
    }
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      step.value = 1;
      void loadMirrors();
    }
  },
  // Immediate: the dialog can be mounted already open, and the step must not hang on a read that
  // never started because the change never happened.
  { immediate: true },
);

function close(): void {
  emit("update:open", false);
}

function next(): void {
  if (step.value < STEPS) {
    step.value += 1;
  }
}

function back(): void {
  if (step.value > 1) {
    step.value -= 1;
  }
}

function submit(): void {
  if (props.busy) {
    return;
  }
  emit("confirm");
}
</script>

<template>
  <ContainerDialog
    :open="props.open"
    :title="t('container.desktop.update.title', { name: props.reference })"
    :busy="props.busy"
    @update:open="close()"
  >
    <!-- Where in the list the reader is: five questions, one on screen. -->
    <p class="mb-3 text-[10px] text-muted-foreground" data-update-step-label>
      {{ t("container.desktop.update.step", { current: String(step), total: String(STEPS) }) }}
    </p>

    <!-- Step 1: what runs on this image, named. -->
    <div v-if="step === 1" data-update-step-affected>
      <p class="text-xs leading-relaxed">
        {{
          props.affected.length === 0
            ? t("container.desktop.update.affectedNone")
            : t("container.desktop.update.affected", { count: String(props.affected.length) })
        }}
      </p>
      <ul
        v-if="props.affected.length > 0"
        class="mt-2 max-h-32 space-y-0.5 overflow-y-auto rounded-md border border-border bg-muted/40 px-3 py-2"
      >
        <li
          v-for="container in props.affected"
          :key="container.id"
          class="font-mono text-[11px] break-all text-muted-foreground"
        >
          {{ container.name }} — {{ container.state }}
        </li>
      </ul>
    </div>

    <!-- Step 2: what the data does, said in full. -->
    <p v-else-if="step === 2" class="text-xs leading-relaxed" data-update-step-data>
      {{ t("container.desktop.update.dataRisk") }}
    </p>

    <!-- Step 3: where the pull would come from, as the daemon answers it today. -->
    <div v-else-if="step === 3" data-update-step-mirrors>
      <p class="text-xs leading-relaxed">{{ t("container.desktop.update.sourceLead") }}</p>
      <p v-if="mirrorsLoading" class="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <LoaderCircle :size="12" class="animate-spin" />
        {{ t("container.desktop.update.sourceReading") }}
      </p>
      <p v-else-if="mirrorsFailed || settings === null" class="mt-2 text-[11px] text-destructive select-text">
        {{ t("container.desktop.update.sourceFailed") }}
      </p>
      <template v-else>
        <ul v-if="settings.mirrors && settings.mirrors.length > 0" class="mt-2 space-y-0.5">
          <li v-for="mirror in settings.mirrors" :key="mirror" class="font-mono text-[11px] break-all select-text">
            {{ mirror }}
          </li>
        </ul>
        <p v-else class="mt-2 text-[11px] text-muted-foreground">{{ t("container.desktop.update.sourceNone") }}</p>
      </template>
    </div>

    <!-- Step 4: what cannot be taken back, and what keeps it from running twice. -->
    <p v-else-if="step === 4" class="text-xs leading-relaxed" data-update-step-committing>
      {{ t("container.desktop.update.committing") }}
    </p>

    <!-- Step 5: the sentence to read if the pull fails. -->
    <p v-else class="text-xs leading-relaxed" data-update-step-failure>
      {{ t("container.desktop.update.failure") }}
    </p>

    <template #footer>
      <WbButton :disabled="props.busy" @click="close()">{{ t("common.action.cancel") }}</WbButton>
      <WbButton v-if="step > 1" :disabled="props.busy" @click="back()">{{
        t("container.desktop.update.back")
      }}</WbButton>
      <WbButton v-if="step < STEPS" variant="primary" :disabled="props.busy" @click="next()">
        {{ t("container.desktop.update.continue") }}
      </WbButton>
      <WbButton
        v-else
        variant="primary"
        :busy="props.busy"
        :disabled="props.busy"
        data-update-confirm
        @click="submit()"
      >
        {{ t("container.desktop.update.confirm") }}
      </WbButton>
    </template>
  </ContainerDialog>
</template>
