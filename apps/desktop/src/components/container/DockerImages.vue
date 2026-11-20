<script setup lang="ts">
/**
 * The Docker window's image page: what the engine has pulled, what it costs, and what uses it.
 *
 * The used-status column is the question the list exists to answer — "can I delete this?" is
 * "is anything running from it?", so the count of containers on each image is drawn right beside
 * the image, and "show the containers" is the row's first menu entry. Removal keeps the gate the
 * whole workspace uses: the confirmation, the `acknowledged` flag it travels with, and the
 * consequence in the message.
 *
 * Pulling is one dialog — repository and tag — with the tag checked against Docker's own grammar
 * as it is typed, because a tag the engine will refuse is cheaper to catch before the pull. The
 * pull itself becomes a task in the panel below, where every transfer of this workspace already
 * lives; the dialog is not a progress bar.
 *
 * The update check is the same pull, entered from the other end: the row asks the registry what a
 * tag names now, and the answer — a newer image or an honest failure to learn either way — lives
 * on the row until a pull of that image completes. An engine whose command line cannot answer the
 * question offers the manual pull only; the check is the one thing the capability bit trims.
 */
import { Ellipsis, RotateCw } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import WbButton from "@/components/ui/WbButton.vue";
import WbEmpty from "@/components/ui/WbEmpty.vue";
import WbTag, { type WbTagTone } from "@/components/ui/WbTag.vue";
import { useContextMenu } from "@/composables/useContextMenu";
import { describeShellError } from "@/i18n/errors";
import { asShellError } from "@/lib/backend/errors";
import { backend } from "@/lib/backend/api";
import type { MenuEntry } from "@/lib/menu/types";
import { TABLE, rowClass } from "@/lib/table";
import { cn } from "@/lib/utils";
import {
  type ContainerSession,
  filterImages,
  imageRef,
  matchesImage,
  relatedContainers,
  useContainerStore,
} from "@/stores/container";
import type { ContainerTab } from "@/stores/terminals";
import type { ContainerImage } from "@/types/container";

import ContainerDialog from "./ContainerDialog.vue";
import ImageTaskPanel from "./ImageTaskPanel.vue";
import ImageUpdateDialog from "./ImageUpdateDialog.vue";
import RegistryCard from "./RegistryCard.vue";
import { imageReference, isValidImageName, isValidImageTag } from "./imageTags";

const props = defineProps<{ tab: ContainerTab; session: ContainerSession }>();

const emit = defineEmits<{
  /** Somebody asked which containers run an image: the pane shows the list, filtered to it. */
  "view-related": [reference: string];
}>();

const { t } = useI18n();
const containers = useContainerStore();
const { openMenu } = useContextMenu();

function translate(key: string, params?: Record<string, string>): string {
  return params ? t(key, params) : t(key);
}

const text = ref("");
const rows = computed(() => filterImages(props.session.images, text.value));

function usedCount(image: ContainerImage): number {
  return relatedContainers(props.session.containers, image);
}

function usedLabel(count: number): string {
  return count > 0 ? t("container.desktop.images.used") : t("container.desktop.images.unused");
}

// -- the pull dialog ------------------------------------------------------------

const pullingOpen = ref(false);
const pullName = ref("");
const pullTag = ref("");
const pullBusy = ref(false);

function openPull(): void {
  pullName.value = "";
  pullTag.value = "";
  pullBusy.value = false;
  pullingOpen.value = true;
}

/** Said only when it is true: an untouched tag field is not an error. */
const tagValid = computed(() => isValidImageTag(pullTag.value));
const nameValid = computed(() => isValidImageName(pullName.value));
const pullReady = computed(() => nameValid.value && tagValid.value && !pullBusy.value);

async function submitPull(): Promise<void> {
  if (!pullReady.value) {
    return;
  }
  pullBusy.value = true;
  try {
    await containers.pullImage(props.tab.id, {
      image: imageReference(pullName.value, pullTag.value),
      platform: undefined,
      allTags: false,
    });
    pullingOpen.value = false;
  } catch {
    // The store kept the envelope; the pane's banner shows it.
  } finally {
    pullBusy.value = false;
  }
}

// -- the update check ------------------------------------------------------------

/**
 * What one row knows about its tag, from the last time it asked.
 *
 * `newer` is the badge; `current` and `undecided` are answers without one; `failed` keeps the
 * sentence the registry answered with. The map is keyed by the reference a pull would carry, so a
 * list refresh does not lose it and a finished pull clears it.
 */
type UpdateCheck =
  | { kind: "checking" }
  | { kind: "newer" }
  | { kind: "current" }
  | { kind: "undecided" }
  | { kind: "failed"; message: string };

const updateChecks = ref(new Map<string, UpdateCheck>());

/** The check is offered wherever the engine's capability bit does not say no. */
const checkOffered = computed(() => props.session.info?.manifestInspectAvailable !== false);

/** An image with no tag has no registry question: the id names it locally, not remotely. */
function hasNamedReference(image: ContainerImage): boolean {
  return image.repository !== "<none>" && image.tag !== "" && image.tag !== "<none>";
}

function updateOffered(image: ContainerImage): boolean {
  return checkOffered.value && hasNamedReference(image);
}

async function checkUpdate(image: ContainerImage): Promise<void> {
  const reference = imageRef(image);
  const connectionId = props.session.connectionId;
  if (connectionId === null || updateChecks.value.get(reference)?.kind === "checking") {
    return;
  }
  updateChecks.value.set(reference, { kind: "checking" });
  try {
    const answer = await backend.dockerRegistry.remoteDigest(connectionId, reference);
    if (answer.upToDate === true) {
      updateChecks.value.set(reference, { kind: "current" });
    } else if (answer.upToDate === false) {
      updateChecks.value.set(reference, { kind: "newer" });
    } else {
      // The registry answered and the local half did not: an image loaded from an archive has no
      // pull record to compare against, and calling that either way would be a guess.
      updateChecks.value.set(reference, { kind: "undecided" });
    }
  } catch (error) {
    updateChecks.value.set(reference, {
      kind: "failed",
      message: describeShellError(translate, asShellError(error, "image_remote_digest")).message,
    });
  }
}

// A pull that finished is the answer the badge was waiting for: the list has been refreshed with
// what the pull brought, so the row's check is history. A failed or stopped pull leaves the badge
// — the newer image is still there to be pulled.
watch(
  () => props.session.tasks.map((task) => `${task.kind}:${task.image}:${task.status}`).join("\n"),
  () => {
    for (const task of props.session.tasks) {
      if (task.kind === "pull" && task.status === "done") {
        updateChecks.value.delete(task.image);
      }
    }
  },
);

interface UpdateTag {
  label: string;
  tone: WbTagTone;
  title?: string;
}

function updateTagFor(image: ContainerImage): UpdateTag | null {
  const check = updateChecks.value.get(imageRef(image));
  if (!check) {
    return null;
  }
  switch (check.kind) {
    case "checking":
      return { label: t("container.desktop.images.checkingTag"), tone: "neutral" };
    case "newer":
      return { label: t("container.desktop.images.updateTag"), tone: "warning" };
    case "current":
      return { label: t("container.desktop.images.currentTag"), tone: "neutral" };
    case "undecided":
      return { label: t("container.desktop.images.undecidedTag"), tone: "neutral" };
    case "failed":
      return { label: t("container.desktop.images.checkFailedTag"), tone: "neutral", title: check.message };
  }
}

// -- the update dialog -------------------------------------------------------------

const updateOpen = ref(false);
const updateBusy = ref(false);
/** The reference the open dialog would pull, or null while it is closed. */
const updating = ref<string | null>(null);

function openUpdate(image: ContainerImage): void {
  updating.value = imageRef(image);
  updateOpen.value = true;
}

const affectedForUpdate = computed(() =>
  updating.value === null
    ? []
    : props.session.containers.filter((container) => matchesImage(container, updating.value as string)),
);

async function confirmUpdate(): Promise<void> {
  const reference = updating.value;
  if (reference === null || updateBusy.value) {
    return;
  }
  // The pull is its own guard: an update already running for this image is not started again —
  // the panel below is where it lives, and a second one would only fight it for the tag.
  if (
    props.session.tasks.some((task) => task.kind === "pull" && task.image === reference && task.status === "running")
  ) {
    updateOpen.value = false;
    return;
  }
  updateBusy.value = true;
  try {
    await containers.pullImage(props.tab.id, { image: reference, platform: undefined, allTags: false });
    updateOpen.value = false;
  } catch {
    // The store kept the envelope; the pane's banner shows it.
  } finally {
    updateBusy.value = false;
  }
}

// -- the row menu and removal ----------------------------------------------------

const removing = ref<ContainerImage | null>(null);

function openRowMenu(event: MouseEvent, image: ContainerImage): void {
  const entries: MenuEntry[] = [
    {
      kind: "action",
      id: "related",
      labelKey: "container.desktop.images.showRelated",
      run: () => emit("view-related", imageRef(image)),
    },
  ];
  if (updateOffered(image)) {
    entries.push({
      kind: "action",
      id: "checkUpdate",
      labelKey: "container.desktop.images.checkUpdate",
      run: () => {
        void checkUpdate(image);
      },
    });
    if (updateChecks.value.get(imageRef(image))?.kind === "newer") {
      entries.push({
        kind: "action",
        id: "update",
        labelKey: "container.desktop.images.update",
        run: () => openUpdate(image),
      });
    }
  }
  entries.push({
    kind: "action",
    id: "remove",
    labelKey: "container.image.remove",
    danger: true,
    run: () => {
      removing.value = image;
    },
  });
  openMenu(event, { key: "container.image.menu", params: { name: imageRef(image) } }, entries);
}

async function removeImage(): Promise<void> {
  const image = removing.value;
  removing.value = null;
  if (!image) {
    return;
  }
  try {
    await containers.removeImage(props.tab.id, imageRef(image));
  } catch {
    // The store kept the envelope; the pane's banner shows it.
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- The page head: the reference's own measure — the page's name bold, the 300px search, the
         primary action at the far end. -->
    <div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <h2 class="shrink-0 text-lg font-bold leading-none">{{ t("container.rail.images") }}</h2>
      <input
        v-model="text"
        type="text"
        spellcheck="false"
        class="h-7 w-[300px] rounded-sm border border-border bg-background px-2.5 text-xs focus:outline-none"
        :placeholder="t('container.images.filter')"
        :aria-label="t('container.images.filter')"
      />
      <div class="min-w-0 flex-1"></div>
      <WbButton variant="primary" data-docker-images-pull @click="openPull()">
        {{ t("container.image.pull") }}
      </WbButton>
      <button
        type="button"
        class="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--workbench-on-picture)_6%,transparent)] hover:text-foreground"
        :title="t('container.refresh')"
        :aria-label="t('container.refresh')"
        @click="containers.loadImages(props.tab.id)"
      >
        <RotateCw :size="12" />
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto px-3">
      <table
        :class="cn(TABLE.page.table, 'table-fixed')"
        :style="{ minWidth: '640px' }"
        :aria-label="t('container.rail.images')"
      >
        <thead :class="TABLE.page.head">
          <tr :class="TABLE.page.headRow">
            <th class="w-[42%]" :class="TABLE.page.headCell">{{ t("container.col.tag") }}</th>
            <th class="w-[14%]" :class="TABLE.page.headCell">{{ t("container.col.size") }}</th>
            <th class="w-[18%]" :class="TABLE.page.headCell">{{ t("container.col.created") }}</th>
            <th class="w-[18%]" :class="TABLE.page.headCell">{{ t("container.desktop.images.usedBy") }}</th>
            <th class="w-[3rem]" :class="TABLE.page.headCell">{{ t("container.col.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="image in rows" :key="image.id" :class="cn(rowClass('page', { clickable: true, striped: true }))">
            <td :class="TABLE.page.cell">
              <div class="flex items-center gap-1.5">
                <span class="block min-w-0 truncate font-mono text-[11px]" :title="imageRef(image)">
                  {{ imageRef(image) }}
                </span>
                <WbTag
                  v-if="updateTagFor(image)"
                  :tone="updateTagFor(image)!.tone"
                  :title="updateTagFor(image)!.title"
                  data-docker-image-update
                >
                  {{ updateTagFor(image)!.label }}
                </WbTag>
              </div>
            </td>
            <td :class="TABLE.page.cell">
              <span class="block truncate font-mono text-[11px]">{{ image.size }}</span>
            </td>
            <td :class="TABLE.page.cell">
              <span class="block truncate text-[11px] text-muted-foreground">{{ image.createdAt }}</span>
            </td>
            <td :class="TABLE.page.cell">
              <WbTag :tone="usedCount(image) > 0 ? 'success' : 'neutral'" data-docker-image-used>
                {{ usedLabel(usedCount(image)) }}
              </WbTag>
            </td>
            <td :class="TABLE.page.cell">
              <button
                type="button"
                class="grid size-5 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--workbench-on-picture)_6%,transparent)] hover:text-foreground"
                :title="t('container.image.more', { name: imageRef(image) })"
                :aria-label="t('container.image.more', { name: imageRef(image) })"
                @click="openRowMenu($event, image)"
              >
                <Ellipsis :size="12" />
              </button>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td :colspan="5" :class="cn(TABLE.page.cell, TABLE.page.emptyCell)">
              <WbEmpty scenario="noData" size="sm" :description="t('container.images.none')" class="mx-auto" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- The transfers this workspace has started, wherever in the window they were started. -->
    <ImageTaskPanel :tab-id="props.tab.id" :tasks="props.session.tasks" />

    <!--
      Where this engine pulls from — the facts the update dialog quotes, said once on the page the
      updates happen on. A read, like everything else on this page; the copy button carries the
      fragment away and writes nothing.
    -->
    <div class="shrink-0 px-3 pb-3">
      <RegistryCard :connection-id="props.session.connectionId" />
    </div>

    <!--
      The pull: a repository and, optionally, a tag. The tag is checked while it is typed, against
      Docker's own grammar; the hint is said only when it is true, for the same reason the shortcut
      dialog's is.
    -->
    <ContainerDialog
      :open="pullingOpen"
      :title="t('container.transfer.pullTitle')"
      :busy="pullBusy"
      @update:open="pullingOpen = $event"
    >
      <label class="flex flex-col gap-1">
        <span class="text-[11px] text-muted-foreground">{{ t("container.transfer.image") }}</span>
        <input
          v-model="pullName"
          type="text"
          spellcheck="false"
          class="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
          :placeholder="t('container.create.imagePlaceholder')"
          :aria-label="t('container.transfer.image')"
          @keydown.enter.prevent="submitPull()"
        />
      </label>
      <label class="mt-2 flex flex-col gap-1">
        <span class="text-[11px] text-muted-foreground">{{ t("container.desktop.images.tagLabel") }}</span>
        <input
          v-model="pullTag"
          type="text"
          spellcheck="false"
          class="rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none"
          :placeholder="t('container.desktop.images.tagPlaceholder')"
          :aria-label="t('container.desktop.images.tagLabel')"
          @keydown.enter.prevent="submitPull()"
        />
      </label>
      <p v-if="!tagValid" class="mt-2 text-[11px] text-destructive">{{ t("container.desktop.images.tagInvalid") }}</p>
      <template #footer>
        <WbButton @click="pullingOpen = false">{{ t("common.action.cancel") }}</WbButton>
        <WbButton variant="primary" :busy="pullBusy" :disabled="!nameValid" @click="submitPull()">
          {{ pullBusy ? t("container.loadingActions.pulling") : t("container.transfer.submit") }}
        </WbButton>
      </template>
    </ContainerDialog>

    <!--
      Removal keeps the workspace's gate: the confirmation carries the consequence, and the flag it
      sends is the backend's permission to act.
    -->
    <ConfirmDialog
      :open="removing !== null"
      :title="t('container.image.removeTitle', { name: removing ? imageRef(removing) : '' })"
      :message="t('container.image.removeMessage')"
      :confirm-label="t('container.image.removeVerb')"
      danger
      @confirm="removeImage()"
      @update:open="removing = null"
    />

    <!--
      The update's own gate: five questions walked in order, each with its way out, and the confirm
      is the existing pull — the same task panel row, the same stream, no second pipeline.
    -->
    <ImageUpdateDialog
      :open="updateOpen"
      :reference="updating ?? ''"
      :affected="affectedForUpdate"
      :connection-id="props.session.connectionId"
      :busy="updateBusy"
      @confirm="confirmUpdate()"
      @update:open="updateOpen = $event"
    />
  </div>
</template>
