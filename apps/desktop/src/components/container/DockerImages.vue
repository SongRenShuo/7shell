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
 */
import { Ellipsis, RotateCw } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import WbButton from "@/components/ui/WbButton.vue";
import WbEmpty from "@/components/ui/WbEmpty.vue";
import WbTag from "@/components/ui/WbTag.vue";
import { useContextMenu } from "@/composables/useContextMenu";
import type { MenuEntry } from "@/lib/menu/types";
import { TABLE, rowClass } from "@/lib/table";
import { cn } from "@/lib/utils";
import {
  type ContainerSession,
  filterImages,
  imageRef,
  relatedContainers,
  useContainerStore,
} from "@/stores/container";
import type { ContainerTab } from "@/stores/terminals";
import type { ContainerImage } from "@/types/container";

import ContainerDialog from "./ContainerDialog.vue";
import ImageTaskPanel from "./ImageTaskPanel.vue";
import { imageReference, isValidImageName, isValidImageTag } from "./imageTags";

const props = defineProps<{ tab: ContainerTab; session: ContainerSession }>();

const emit = defineEmits<{
  /** Somebody asked which containers run an image: the pane shows the list, filtered to it. */
  "view-related": [reference: string];
}>();

const { t } = useI18n();
const containers = useContainerStore();
const { openMenu } = useContextMenu();

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
    {
      kind: "action",
      id: "remove",
      labelKey: "container.image.remove",
      danger: true,
      run: () => {
        removing.value = image;
      },
    },
  ];
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
              <span class="block truncate font-mono text-[11px]" :title="imageRef(image)">{{ imageRef(image) }}</span>
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
  </div>
</template>
