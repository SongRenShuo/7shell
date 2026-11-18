<script setup lang="ts">
/**
 * The application starter: the dark sheet that comes over the desktop when somebody asks for
 * everything at once.
 *
 * It is presentational. What the applications are, what their icons look like and what launching
 * one means belong to whoever hands over `apps`; this component only draws the grid, says which
 * tile was clicked, and says when the sheet should go away. That is why it can be dropped into the
 * desktop shell without knowing where the desktop's data comes from.
 *
 * Two gestures close it — a click on the sheet between the tiles, and Escape — because a full-screen
 * sheet that covers everything must have a way out that does not depend on finding the button in the
 * corner. A click on a tile launches instead, and stops at the tile: the reference uses a single
 * click here even though its desktop icons need two, and that is the right way round, since a tile
 * is already a deliberate act and a desktop icon is something the pointer can catch by accident.
 *
 * The sheet is kept in the DOM and hidden with `v-show` so the 0.4s fade runs in both directions —
 * a `v-if` would remove it the moment it closed, and the fade out would never be seen. While it is
 * closed the container is `inert`, so the tiles it still holds cannot be reached by Tab or by a
 * screen reader even though they exist. The `Transition` wrapper is what lets `v-show` animate at
 * all: Vue keeps the element displayed until the leave transition has finished, which is the part
 * `v-show` alone cannot do.
 */
import { X } from "@lucide/vue";
import type { Component } from "vue";
import { onMounted, onUnmounted } from "vue";

const props = defineProps<{
  /** Whether the sheet is over the desktop. */
  open: boolean;
  /** Everything the starter offers, in the order it is drawn. */
  apps: { id: string; label: string; icon: Component; tone: string }[];
  labels: {
    /** The sheet's accessible name. */
    title: string;
    /** What the close button is called. */
    close: string;
  };
}>();

const emit = defineEmits<{
  /** Somebody asked for the sheet to go away. */
  close: [];
  /** A tile was clicked: this is the application it names. */
  launch: [id: string];
}>();

/**
 * Escape closes the sheet wherever the focus happens to be.
 *
 * The listener lives on the window rather than on the sheet because the sheet's own tiles take the
 * focus, and a key handler on the sheet would only see the key once one of them had it. It is
 * registered once for the life of the component and answers only while the sheet is open, so a
 * closed starter costs one comparison per keypress rather than a handler added and removed on every
 * toggle.
 */
function onKeydown(event: KeyboardEvent): void {
  if (props.open && event.key === "Escape") {
    emit("close");
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <Transition name="starter">
    <div
      v-show="open"
      data-workbench-starter
      class="starter"
      role="dialog"
      aria-modal="true"
      :aria-label="labels.title"
      :inert="!open"
      @click.self="emit('close')"
    >
      <button
        type="button"
        data-workbench-starter-close
        class="starter-close"
        :title="labels.close"
        :aria-label="labels.close"
        @click="emit('close')"
      >
        <X :size="18" />
      </button>

      <ul class="starter-grid">
        <li v-for="app in apps" :key="app.id">
          <button
            type="button"
            data-workbench-starter-app
            :data-app-id="app.id"
            class="starter-tile"
            @click="emit('launch', app.id)"
          >
            <span class="starter-plate" :style="{ background: app.tone }">
              <component :is="app.icon" :size="48" />
            </span>
            <span class="starter-label">{{ app.label }}</span>
          </button>
        </li>
      </ul>
    </div>
  </Transition>
</template>

<style scoped>
/*
 * The sheet sits above the desktop and below the taskbar — the reference's 495598 against its
 * taskbar's 495599, said here as the two local steps it is. Clicking the gaps closes it; the tiles
 * sit in their own layer on top, so their clicks never reach the backdrop.
 */
.starter {
  position: absolute;
  inset: 0;
  z-index: 20;
  overflow-y: auto;
  background: #000000b8;
  opacity: 1;
}

.starter-enter-active,
.starter-leave-active {
  transition: opacity 0.4s;
}

.starter-enter-from,
.starter-leave-to {
  opacity: 0;
}

.starter-close {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  color: #e1e1e1;
  transition:
    background-color 0.2s,
    color 0.2s;
}

.starter-close:hover,
.starter-close:focus-visible {
  background: #ffffff2e;
  color: #ffffff;
}

.starter-close:focus-visible,
.starter-tile:focus-visible {
  outline: 1px solid #ffffffa0;
  outline-offset: -1px;
}

/* The reference's grid: 140px columns of 100px tiles, centred, with 22px of air at the top. */
.starter-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 140px);
  justify-content: center;
  justify-items: center;
  width: 100%;
  margin: 0;
  padding: 22px;
  list-style: none;
}

.starter-tile {
  display: flex;
  width: 100px;
  height: 100px;
  margin: 7px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 7px;
  transition: background-color 0.2s;
  cursor: pointer;
}

.starter-tile:hover {
  background: #ffffff2e;
  backdrop-filter: blur(15px);
  -webkit-backdrop-filter: blur(15px);
}

/* The coloured plate keeps the linear icons looking like the reference's stickers. */
.starter-plate {
  display: flex;
  width: 58px;
  height: 58px;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  color: #ffffff;
}

.starter-label {
  max-width: 100px;
  overflow: hidden;
  color: #e1e1e1;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.2;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
