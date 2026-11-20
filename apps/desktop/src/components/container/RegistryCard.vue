<script setup lang="ts">
/**
 * Where this engine pulls from, said as a fact and never as a form.
 *
 * The mirrors and the proxy are the daemon's own answers, read once when the card arrives — a
 * settings page this build does not have, because writing a daemon's registry configuration is the
 * one line the plan draws in red. What the card offers instead is the fragment: the same facts
 * spelled the way a `daemon.json` would name them, for carrying to the machine that needs them.
 * The button copies; nothing is written anywhere.
 */
import { Copy } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import WbButton from "@/components/ui/WbButton.vue";
import { backend } from "@/lib/backend/api";
import type { ContainerRegistrySettings } from "@/types/container";

const props = defineProps<{ connectionId: string | null }>();

const { t } = useI18n();

const loading = ref(false);
const failed = ref(false);
const settings = ref<ContainerRegistrySettings | null>(null);
let generation = 0;
let copyTimer: number | undefined;

async function load(): Promise<void> {
  const connectionId = props.connectionId;
  const current = ++generation;
  settings.value = null;
  failed.value = false;
  if (connectionId === null) {
    return;
  }
  loading.value = true;
  try {
    const answer = await backend.dockerRegistry.info(connectionId);
    if (current === generation) {
      settings.value = answer;
    }
  } catch {
    if (current === generation) {
      failed.value = true;
    }
  } finally {
    if (current === generation) {
      loading.value = false;
    }
  }
}

watch(
  () => props.connectionId,
  () => {
    void load();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  window.clearTimeout(copyTimer);
});

const mirrors = computed(() => settings.value?.mirrors ?? []);
const httpProxy = computed(() => settings.value?.httpProxy ?? "");
const httpsProxy = computed(() => settings.value?.httpsProxy ?? "");
const noProxy = computed(() => settings.value?.noProxy ?? "");

const configured = computed(
  () => mirrors.value.length > 0 || httpProxy.value !== "" || httpsProxy.value !== "" || noProxy.value !== "",
);

/**
 * The same facts as the fragment a daemon configuration would carry.
 *
 * Keys are spelled the way Docker's own `daemon.json` names them; a field the daemon does not use
 * stays out of the fragment, and a daemon configured with neither mirrors nor proxy has no
 * fragment to give — the button says so by being absent rather than copying an empty shape.
 */
const snippet = computed(() => {
  if (!configured.value) {
    return "";
  }
  const fragment: Record<string, unknown> = {};
  if (mirrors.value.length > 0) {
    fragment["registry-mirrors"] = mirrors.value;
  }
  const proxies: Record<string, string> = {};
  if (httpProxy.value !== "") {
    proxies["http-proxy"] = httpProxy.value;
  }
  if (httpsProxy.value !== "") {
    proxies["https-proxy"] = httpsProxy.value;
  }
  if (noProxy.value !== "") {
    proxies["no-proxy"] = noProxy.value;
  }
  if (Object.keys(proxies).length > 0) {
    fragment["proxies"] = proxies;
  }
  return JSON.stringify(fragment, null, 2);
});

const copied = ref(false);

async function copySnippet(): Promise<void> {
  try {
    await navigator.clipboard.writeText(snippet.value);
    copied.value = true;
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    // The fragment is selectable on screen; the clipboard is only the shortcut.
  }
}
</script>

<template>
  <section
    class="rounded-md border border-border bg-card px-3 py-2.5"
    data-registry-card
    :aria-label="t('container.desktop.registry.title')"
  >
    <div class="mb-1.5 flex items-center justify-between gap-2">
      <h3 class="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {{ t("container.desktop.registry.title") }}
      </h3>
      <WbButton v-if="snippet !== ''" :disabled="copied" data-registry-copy class="shrink-0" @click="copySnippet()">
        <span class="flex items-center gap-1.5">
          <Copy :size="11" aria-hidden="true" />
          {{ copied ? t("container.detail.copied") : t("container.desktop.registry.snippet") }}
        </span>
      </WbButton>
    </div>

    <p v-if="loading" class="text-[11px] text-muted-foreground">{{ t("container.desktop.registry.reading") }}</p>
    <p v-else-if="failed" class="text-[11px] text-destructive select-text">
      {{ t("container.desktop.registry.failed") }}
    </p>
    <p v-else-if="!configured" class="text-[11px] text-muted-foreground">
      {{ t("container.desktop.registry.empty") }}
    </p>
    <div v-else class="space-y-0.5">
      <p v-for="mirror in mirrors" :key="mirror" class="font-mono text-[11px] break-all select-text">
        {{ mirror }}
      </p>
      <p v-if="httpProxy !== ''" class="font-mono text-[11px] break-all select-text">
        {{ t("container.desktop.registry.http") }} {{ httpProxy }}
      </p>
      <p v-if="httpsProxy !== ''" class="font-mono text-[11px] break-all select-text">
        {{ t("container.desktop.registry.https") }} {{ httpsProxy }}
      </p>
      <p v-if="noProxy !== ''" class="font-mono text-[11px] break-all select-text">
        {{ t("container.desktop.registry.no") }} {{ noProxy }}
      </p>
    </div>
  </section>
</template>
