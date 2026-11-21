<script setup lang="ts">
/**
 * One image: what it was built from, how it is configured, which tags its repository carries, and
 * its raw inspect.
 *
 * The layers are read first because they are the thing a size question is really about — "why is
 * this image 1.2 GB" is answered by the layer whose command dwarfs the rest. A layer's command is
 * one line until it is clicked, since a `RUN` with a long script is otherwise a wall of text over
 * every other layer.
 *
 * The tags section lists what the engine holds for the image's repository. Each tag's update
 * state is the images page's question (`remoteDigest`) asked of that tag, answered with the same
 * three tones; the sweep walks the list a few lanes at a time, the way the images page's own
 * recheck does, and a tag the engine has never asked about reads "not checked" — the honest
 * third state — until somebody asks.
 *
 * The raw inspect stays available as JSON: the fields the interface draws are the common ones, and
 * an image configured in a way this view does not know about is still readable there.
 */
import { X } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import WbTag, { type WbTagTone } from "@/components/ui/WbTag.vue";
import { describeShellError } from "@/i18n/errors";
import { asShellError } from "@/lib/backend/errors";
import { runLimited } from "@/lib/concurrency";
import { imageRef, shortId, useContainerStore } from "@/stores/container";
import type { ContainerImage, ImageLayer } from "@/types/container";

const props = defineProps<{
  mode: "detail" | null;
  tabId: string;
  target: ContainerImage | null;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const containers = useContainerStore();

const tab = ref<"layers" | "tags" | "detail" | "json">("layers");
const layers = ref<ImageLayer[]>([]);
const layersFailure = ref<string | null>(null);
const layersLoading = ref(false);
const raw = ref("");
const detailFailure = ref<string | null>(null);
const detailLoading = ref(false);
const expanded = ref<ReadonlySet<number>>(new Set());
const copied = ref(false);
let layersGeneration = 0;
let detailGeneration = 0;
let copyTimer: number | undefined;

// -- the repository's tags -------------------------------------------------------

/**
 * What one tag knows about itself, from the last time the registry was asked. The same five
 * answers the images page's column carries, keyed by the reference a pull would take.
 */
type TagCheck =
  | { kind: "checking" }
  | { kind: "newer" }
  | { kind: "current" }
  | { kind: "undecided" }
  | { kind: "failed"; message: string };

/**
 * How many tags one sweep keeps in flight — the images page's own lane count: registries
 * rate-limit, and the question stays quick without turning into a flood.
 */
const TAG_CHECK_CONCURRENCY = 4;

const tags = ref<ContainerImage[]>([]);
const tagsFailure = ref<string | null>(null);
const tagsLoading = ref(false);
const tagChecks = ref(new Map<string, TagCheck>());
const tagsSweepRunning = ref(false);
const tagsSweepDone = ref(0);
let tagsGeneration = 0;

/** The repository the tags section asks about; an unnamed image has none to ask about. */
const tagsRepository = computed(() =>
  props.target && props.target.repository !== "<none>" ? props.target.repository : "",
);

/** The check is offered wherever the engine's capability bit does not say no. */
const tagCheckOffered = computed(() => containers.sessionFor(props.tabId)?.info?.manifestInspectAvailable !== false);

/** A tag with no name has no registry question: the id names it locally, not remotely. */
function tagHasNamedReference(tag: ContainerImage): boolean {
  return tag.repository !== "<none>" && tag.tag !== "" && tag.tag !== "<none>";
}

interface TagState {
  label: string;
  tone: WbTagTone;
  title?: string;
}

/** What the state column says about one tag, always something, in the images page's own words. */
function tagStateFor(tag: ContainerImage): TagState {
  const check = tagChecks.value.get(imageRef(tag));
  if (!check) {
    return { label: t("container.desktop.images.unknownTag"), tone: "neutral" };
  }
  switch (check.kind) {
    case "checking":
      return { label: t("container.desktop.images.checkingTag"), tone: "neutral" };
    case "newer":
      return { label: t("container.desktop.images.updateTag"), tone: "warning" };
    case "current":
      return { label: t("container.desktop.images.currentTag"), tone: "success" };
    case "undecided":
      return { label: t("container.desktop.images.undecidedTag"), tone: "neutral" };
    case "failed":
      return { label: t("container.desktop.images.checkFailedTag"), tone: "neutral", title: check.message };
  }
}

async function checkTag(tag: ContainerImage): Promise<void> {
  const reference = imageRef(tag);
  const connectionId = containers.sessionFor(props.tabId)?.connectionId;
  if (connectionId === null || connectionId === undefined || tagChecks.value.get(reference)?.kind === "checking") {
    return;
  }
  tagChecks.value.set(reference, { kind: "checking" });
  try {
    const answer = await containers.remoteDigest(props.tabId, reference);
    if (answer.upToDate === true) {
      tagChecks.value.set(reference, { kind: "current" });
    } else if (answer.upToDate === false) {
      tagChecks.value.set(reference, { kind: "newer" });
    } else {
      // The registry answered and the local half did not: an image loaded from an archive has no
      // pull record to compare against, and calling that either way would be a guess.
      tagChecks.value.set(reference, { kind: "undecided" });
    }
  } catch (error) {
    tagChecks.value.set(reference, {
      kind: "failed",
      message: describeShellError(translate, asShellError(error, "image_remote_digest")).message,
    });
  }
}

/**
 * Asks the registry about every named tag the listing brought, a few at a time. Each row flips to
 * "checking" as its question leaves and is answered in place; the button carries the count while
 * the sweep is out.
 */
async function checkAllTags(): Promise<void> {
  if (tagsSweepRunning.value) {
    return;
  }
  const targets = tags.value.filter(tagHasNamedReference);
  if (targets.length === 0) {
    return;
  }
  tagsSweepRunning.value = true;
  tagsSweepDone.value = 0;
  try {
    await runLimited(targets, TAG_CHECK_CONCURRENCY, async (tag) => {
      await checkTag(tag);
      tagsSweepDone.value += 1;
    });
  } finally {
    tagsSweepRunning.value = false;
  }
}

async function loadTags(): Promise<void> {
  const repository = tagsRepository.value;
  if (repository === "") {
    tags.value = [];
    tagsFailure.value = null;
    return;
  }
  const generation = ++tagsGeneration;
  tags.value = [];
  tagChecks.value = new Map();
  tagsFailure.value = null;
  tagsLoading.value = true;
  try {
    const answer = await containers.imageTags(props.tabId, repository);
    if (generation === tagsGeneration) {
      tags.value = answer;
    }
  } catch (error) {
    if (generation === tagsGeneration) {
      tagsFailure.value = describeShellError(translate, asShellError(error, "container_image_tags")).message;
    }
  } finally {
    if (generation === tagsGeneration) {
      tagsLoading.value = false;
    }
  }
}

function translate(key: string, params?: Record<string, string>): string {
  return params ? t(key, params) : t(key);
}

function fullRef(image: ContainerImage): string {
  return `${image.repository}:${image.tag}`;
}

/**
 * What the inspect and history calls are given.
 *
 * The full `repo:tag` when there is one — `nerdctl` refuses a short id with "multiple ids found" —
 * and the id otherwise, for an image whose tags have all been removed.
 */
function queryRef(image: ContainerImage): string {
  if (image.repository !== "<none>" && image.tag && image.tag !== "<none>") {
    return fullRef(image);
  }
  return image.id;
}

const title = computed(() => (props.target ? fullRef(props.target) : ""));

const prettyRaw = computed(() => {
  if (raw.value === "") {
    return "";
  }
  try {
    const parsed = JSON.parse(raw.value);
    return JSON.stringify(Array.isArray(parsed) ? parsed[0] : parsed, null, 2);
  } catch {
    return raw.value;
  }
});

function toggleLayer(index: number): void {
  const next = new Set(expanded.value);
  if (next.has(index)) {
    next.delete(index);
  } else {
    next.add(index);
  }
  expanded.value = next;
}

async function loadLayers(): Promise<void> {
  const target = props.target;
  if (!target) {
    return;
  }
  const generation = ++layersGeneration;
  layers.value = [];
  layersFailure.value = null;
  layersLoading.value = true;
  try {
    const answer = await containers.imageHistory(props.tabId, queryRef(target));
    if (generation === layersGeneration) {
      layers.value = answer;
    }
  } catch (error) {
    if (generation === layersGeneration) {
      layersFailure.value = describeShellError(translate, asShellError(error, "container_image_history")).message;
    }
  } finally {
    if (generation === layersGeneration) {
      layersLoading.value = false;
    }
  }
}

async function loadDetail(): Promise<void> {
  const target = props.target;
  if (!target) {
    return;
  }
  const generation = ++detailGeneration;
  raw.value = "";
  detailFailure.value = null;
  detailLoading.value = true;
  try {
    const answer = await containers.imageInspect(props.tabId, queryRef(target));
    if (generation === detailGeneration) {
      raw.value = answer ?? "";
    }
  } catch (error) {
    if (generation === detailGeneration) {
      detailFailure.value = describeShellError(translate, asShellError(error, "container_image_inspect")).message;
    }
  } finally {
    if (generation === detailGeneration) {
      detailLoading.value = false;
    }
  }
}

/**
 * The first object of the inspect answer.
 *
 * A runtime may answer with an array (Docker) or an object (some container tools); the fields are
 * read from the raw JSON because the image's structure is not the container's and there is no wire
 * type that flattens it.
 */
interface InspectShape {
  readonly RepoTags?: unknown;
  readonly Created?: unknown;
  readonly Size?: unknown;
  readonly Architecture?: unknown;
  readonly Os?: unknown;
  readonly Config?: {
    readonly Entrypoint?: unknown;
    readonly Cmd?: unknown;
    readonly WorkingDir?: unknown;
    readonly User?: unknown;
    readonly ExposedPorts?: unknown;
    readonly Volumes?: unknown;
    readonly Env?: unknown;
    readonly Labels?: unknown;
  };
}

function firstObject(): InspectShape | null {
  if (raw.value === "") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw.value);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return first && typeof first === "object" ? (first as InspectShape) : null;
  } catch {
    return null;
  }
}

function joinList(value: unknown): string {
  return Array.isArray(value) ? value.filter(Boolean).join(", ") : "";
}

function joinKeys(value: unknown): string {
  return value && typeof value === "object" ? Object.keys(value).join(", ") : "";
}

function joinEntries(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  return Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => `${key}=${String(entry)}`)
    .join("\n");
}

function humanSize(bytes: unknown): string {
  const amount = Number(bytes);
  if (!Number.isFinite(amount) || amount <= 0) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = amount;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit] ?? "B"}`;
}

interface DetailSection {
  label: string;
  fields: [string, string][];
}

const detailSections = computed<DetailSection[]>(() => {
  const image = firstObject();
  if (!image) {
    return [];
  }
  const config = image.Config;
  const sections: DetailSection[] = [
    {
      label: t("container.detail.sectionOverview"),
      fields: [
        [t("container.imageFields.repoTags"), joinList(image.RepoTags)],
        [t("container.detail.fieldId"), props.target ? shortId(props.target.id) : ""],
        [t("container.imageFields.size"), humanSize(image.Size)],
        [
          t("container.imageFields.created"),
          image.Created ? String(image.Created).replace("T", " ").replace("Z", " UTC") : "",
        ],
      ],
    },
    {
      label: t("container.imageFields.sectionConfig"),
      fields: [
        [t("container.overview.arch"), [image.Architecture, image.Os].filter(Boolean).join("/")],
        [t("container.detail.fieldEntrypoint"), joinList(config?.Entrypoint)],
        [t("container.detail.fieldCommand"), joinList(config?.Cmd)],
        [t("container.detail.fieldWorkDir"), config?.WorkingDir ? String(config.WorkingDir) : ""],
        [t("container.detail.fieldUser"), config?.User ? String(config.User) : ""],
        [t("container.imageFields.exposedPorts"), joinKeys(config?.ExposedPorts)],
        [t("container.imageFields.volumes"), joinKeys(config?.Volumes)],
      ],
    },
    {
      label: t("container.detail.sectionEnv"),
      fields: joinList(config?.Env) !== "" ? [[t("container.detail.sectionEnv"), joinList(config?.Env)]] : [],
    },
    {
      label: t("container.imageFields.labels"),
      fields:
        joinEntries(config?.Labels) !== "" ? [[t("container.imageFields.labels"), joinEntries(config?.Labels)]] : [],
    },
  ];
  return sections.filter((section) => section.fields.length > 0);
});

async function copyRaw(): Promise<void> {
  try {
    await navigator.clipboard.writeText(prettyRaw.value);
    copied.value = true;
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    // The JSON is selectable on screen; the clipboard is only the shortcut.
  }
}

watch(
  () => [props.mode, props.target?.id],
  () => {
    if (props.mode === "detail" && props.target) {
      tab.value = "layers";
      void loadLayers();
      void loadTags();
      void loadDetail();
    } else {
      layers.value = [];
      raw.value = "";
      layersFailure.value = null;
      detailFailure.value = null;
      tags.value = [];
      tagChecks.value = new Map();
      tagsFailure.value = null;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  window.clearTimeout(copyTimer);
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
        <span class="min-w-0 truncate font-mono text-xs" :title="title">{{ title }}</span>
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

      <div class="flex shrink-0 gap-0.5 border-b border-border px-2">
        <button
          type="button"
          class="border-b-2 px-2 py-1 text-[11px] transition-colors"
          :class="
            tab === 'layers'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          "
          @click="tab = 'layers'"
        >
          {{ t("container.image.layers") }}
        </button>
        <button
          type="button"
          class="border-b-2 px-2 py-1 text-[11px] transition-colors"
          :class="
            tab === 'tags'
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          "
          @click="tab = 'tags'"
        >
          {{ t("container.image.tags") }}
        </button>
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
          {{ t("container.image.detail") }}
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
          JSON
        </button>
      </div>

      <div v-show="tab === 'layers'" class="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <p v-if="layersLoading" class="text-[11px] text-muted-foreground">{{ t("container.detail.loading") }}</p>
        <p v-else-if="layersFailure" class="text-[11px] text-destructive select-text">{{ layersFailure }}</p>
        <p v-else-if="layers.length === 0" class="text-[11px] text-muted-foreground">—</p>
        <div
          v-for="(layer, index) in layers"
          :key="index"
          class="flex items-baseline gap-2 border-b border-border/50 py-1 last:border-b-0"
        >
          <span class="nums w-8 shrink-0 text-right text-[10px] text-muted-foreground">
            #{{ layers.length - index }}
          </span>
          <button
            type="button"
            class="min-w-0 flex-1 text-left font-mono text-[11px] select-text"
            :class="expanded.has(index) ? 'break-all whitespace-pre-wrap' : 'truncate'"
            :title="layer.createdBy || layer.id"
            @click="toggleLayer(index)"
          >
            {{ layer.createdBy || shortId(layer.id) || "—" }}
          </button>
          <span class="flex shrink-0 items-baseline gap-2">
            <span v-if="layer.size" class="nums text-[10px] text-muted-foreground">{{ layer.size }}</span>
            <span v-if="layer.createdAt" class="text-[10px] text-muted-foreground">{{ layer.createdAt }}</span>
          </span>
        </div>
      </div>

      <!--
        The repository's tags, as the engine holds them. Each row wears the same three-state the
        images page's update column wears; the sweep asks the registry about every named tag a few
        lanes at a time, and a tag nobody has asked about reads "not checked".
      -->
      <div v-show="tab === 'tags'" class="flex min-h-0 flex-1 flex-col" data-image-tags-section>
        <div v-if="tagsRepository !== ''" class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
          <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" :title="tagsRepository">
            {{ tagsRepository }}
            <span class="nums ml-1 font-sans">{{ t("container.image.tagsCount", { count: tags.length }) }}</span>
          </span>
          <button
            v-if="tagCheckOffered && tags.length > 0"
            type="button"
            class="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11px] transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="tagsSweepRunning"
            :aria-label="t('container.desktop.images.checkUpdate')"
            data-image-tags-check
            @click="checkAllTags()"
          >
            {{
              tagsSweepRunning
                ? t("container.desktop.images.checkingProgress", { done: tagsSweepDone, total: tags.length })
                : t("container.desktop.images.checkUpdate")
            }}
          </button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <p v-if="tagsRepository === ''" class="text-[11px] text-muted-foreground">
            {{ t("container.image.tagsNone") }}
          </p>
          <p v-else-if="tagsLoading" class="text-[11px] text-muted-foreground">{{ t("container.detail.loading") }}</p>
          <p v-else-if="tagsFailure" class="text-[11px] text-destructive select-text">{{ tagsFailure }}</p>
          <p v-else-if="tags.length === 0" class="text-[11px] text-muted-foreground">
            {{ t("container.image.tagsEmpty") }}
          </p>
          <div
            v-for="tag in tags"
            :key="`${tag.id}:${tag.tag}`"
            class="flex items-baseline gap-2 border-b border-border/50 py-1 last:border-b-0"
            :data-image-tag-row="imageRef(tag)"
          >
            <span class="min-w-0 flex-1 truncate font-mono text-[11px] select-text" :title="imageRef(tag)">
              {{ tag.tag }}
            </span>
            <span class="flex shrink-0 items-baseline gap-2">
              <span class="nums text-[10px] text-muted-foreground">{{ tag.size }}</span>
              <span class="text-[10px] text-muted-foreground">{{ tag.createdAt }}</span>
              <WbTag :tone="tagStateFor(tag).tone" :title="tagStateFor(tag).title">
                {{ tagStateFor(tag).label }}
              </WbTag>
            </span>
          </div>
        </div>
      </div>

      <div v-show="tab === 'detail'" class="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <p v-if="detailLoading" class="text-[11px] text-muted-foreground">{{ t("container.detail.loading") }}</p>
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
              <dt class="w-32 shrink-0 text-[10px] text-muted-foreground">{{ field[0] }}</dt>
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
    </div>
  </div>
</template>
