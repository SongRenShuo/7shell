<script setup lang="ts">
/**
 * The run→compose conversion, read out of one container: what it would look like as a Compose
 * service, and what the conversion could not say.
 *
 * The dialog reads and shows only — the conversion (see `composeRun.ts`) inspects the container
 * and writes a snippet, and no verb here touches the engine's containers: nothing restarts,
 * nothing is created, and the engine gains nothing it did not already have. The snippet is text
 * for a person to take away: copy it into a Compose file by hand, or download it beside the
 * project's own file.
 *
 * The unresolved list is the conversion's honesty: every inspect parameter the snippet could not
 * carry is named here with its value, in the inspect's own words, rather than dropped. A clean
 * list says so.
 */
import { Check, Copy, LoaderCircle, Download } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import ContainerDialog from "@/components/container/ContainerDialog.vue";
import WbButton from "@/components/ui/WbButton.vue";
import { composeExportFileName, composeServiceFrom, type ComposeServiceDraft } from "@/components/container/composeRun";
import { describeShellError } from "@/i18n/errors";
import { backend } from "@/lib/backend/api";
import { asShellError } from "@/lib/backend/errors";
import type { ContainerSession } from "@/stores/container";
import type { ContainerSummary } from "@/types/container";

const props = defineProps<{
  open: boolean;
  /** The connection the inspect rides; null reads nothing. */
  session: ContainerSession;
  /** The container being converted; null when the dialog is closed. */
  target: ContainerSummary | null;
}>();

const emit = defineEmits<{ (event: "update:open", value: boolean): void }>();

const { t } = useI18n();

function translate(key: string, params?: Record<string, string>): string {
  return params ? t(key, params) : t(key);
}

function describe(error: unknown, operation: string): string {
  return describeShellError(translate, asShellError(error, operation)).message;
}

const converting = ref(false);
const draft = ref<ComposeServiceDraft | null>(null);
const failure = ref<string | null>(null);
const copied = ref(false);
let copyTimer: number | undefined;

watch(
  () => [props.open, props.target?.id] as const,
  ([open]) => {
    if (!open || !props.target || props.session.connectionId === null) {
      return;
    }
    void convert();
  },
  // A dialog already open on arrival reads at once: the watch answers the state, not a change.
  { immediate: true },
);

/** Reads the container once, then hands the reading to the conversion. Nothing else runs. */
async function convert(): Promise<void> {
  const connectionId = props.session.connectionId;
  const target = props.target;
  if (connectionId === null || target === null) {
    return;
  }
  converting.value = true;
  failure.value = null;
  draft.value = null;
  try {
    const detail = await backend.containers.inspect(connectionId, target.id);
    draft.value = composeServiceFrom(detail);
  } catch (error) {
    failure.value = describe(error, "container_inspect");
  } finally {
    converting.value = false;
  }
}

async function copySnippet(): Promise<void> {
  if (draft.value === null) {
    return;
  }
  try {
    await navigator.clipboard.writeText(draft.value.yaml);
    copied.value = true;
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    // The clipboard is a convenience; the snippet is on screen and selectable either way.
  }
}

function downloadSnippet(): void {
  const snippet = draft.value;
  if (snippet === null || props.target === null) {
    return;
  }
  const blob = new Blob([snippet.yaml], { type: "application/x-yaml" });
  const address = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = address;
  anchor.download = composeExportFileName(props.target.name);
  anchor.click();
  URL.revokeObjectURL(address);
}

const unresolvedTitle = computed(() =>
  draft.value === null
    ? ""
    : draft.value.unresolved.length === 0
      ? t("container.convert.unresolvedNone")
      : t("container.convert.unresolvedTitle", { count: String(draft.value.unresolved.length) }),
);
</script>

<template>
  <ContainerDialog
    :open="open"
    :title="t('container.convert.title', { name: target?.name ?? '' })"
    :busy="converting"
    @update:open="emit('update:open', $event)"
  >
    <p class="text-[11px] text-muted-foreground">{{ t("container.convert.intro") }}</p>

    <p v-if="converting" class="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground" data-convert-loading>
      <LoaderCircle :size="12" class="animate-spin" />
      {{ t("container.convert.converting") }}
    </p>
    <template v-else>
      <p
        v-if="failure"
        role="alert"
        class="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive select-text"
        data-convert-failure
      >
        {{ failure }}
      </p>
      <template v-if="draft !== null">
        <label class="mt-2 flex flex-col gap-1">
          <span class="text-[11px] text-muted-foreground">docker-compose.yml</span>
          <textarea
            :value="draft.yaml"
            spellcheck="false"
            rows="14"
            readonly
            data-convert-yml
            class="w-full resize-y rounded-md border border-border bg-muted/30 px-2 py-1 font-mono text-xs leading-relaxed focus:outline-none select-text"
            aria-label="docker-compose.yml"
          ></textarea>
        </label>

        <!-- The parameters the snippet could not carry, named in the inspect's own words. -->
        <div class="mt-2" data-convert-unresolved>
          <p class="text-[11px]" :class="draft.unresolved.length === 0 ? 'text-muted-foreground' : ''">
            {{ unresolvedTitle }}
          </p>
          <ul
            v-if="draft.unresolved.length > 0"
            class="mt-1 max-h-32 space-y-0.5 overflow-y-auto rounded-md border border-border bg-muted/40 px-3 py-2"
          >
            <li
              v-for="line in draft.unresolved"
              :key="line"
              class="font-mono text-[11px] break-all text-muted-foreground"
            >
              {{ line }}
            </li>
          </ul>
        </div>
      </template>
    </template>

    <template #footer>
      <WbButton :disabled="draft === null" data-convert-download @click="downloadSnippet()">
        <Download :size="12" class="mr-1" />
        {{ t("container.convert.download") }}
      </WbButton>
      <WbButton :disabled="draft === null" data-convert-copy @click="copySnippet()">
        <Check v-if="copied" :size="12" class="mr-1" />
        <Copy v-else :size="12" class="mr-1" />
        {{ copied ? t("container.convert.copied") : t("container.convert.copy") }}
      </WbButton>
      <WbButton variant="primary" @click="emit('update:open', false)">
        {{ t("common.action.close") }}
      </WbButton>
    </template>
  </ContainerDialog>
</template>
