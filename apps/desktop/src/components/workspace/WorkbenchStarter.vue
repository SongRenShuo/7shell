<script setup lang="ts">
/**
 * The application starter: the dark sheet that comes over the desktop when somebody asks for
 * everything at once.
 *
 * It is presentational. What the applications are, what their icons look like and what launching
 * one means belong to whoever hands over `apps`; this component draws the search field, the grid,
 * says which tile was clicked, and says when the sheet should go away. That is why it can be
 * dropped into the desktop shell without knowing where the desktop's data comes from.
 *
 * The search field is the sheet's front door: an eleven-tile grid is scannable, but a desktop that
 * grows doors every release needs the one-glance filter, and the field takes the focus the moment
 * the sheet opens so typing starts immediately. The filter waits 300ms after the last keystroke —
 * fast enough to feel instant, slow enough that a whole word typed at speed runs one filter pass —
 * and matches case-insensitively against the label the owner hands over, because the person typing
 * does not know or care how the label is capitalised. An empty field is every application.
 *
 * Two gestures close it — a click on the sheet between the tiles, and Escape — because a full-screen
 * sheet that covers everything must have a way out that does not depend on finding the button in
 * the corner. A click on a tile launches instead, and stops at the tile: the reference uses a single
 * click here even though its desktop icons need two, and that is the right way round, since a tile
 * is already a deliberate act and a desktop icon is something the pointer can catch by accident.
 *
 * The sheet is kept in the DOM and hidden with `v-show` so the animation runs in both directions —
 * a `v-if` would remove it the moment it closed, and the leave would never be seen. While it is
 * closed the container is `inert`, so the tiles it still holds cannot be reached by Tab or by a
 * screen reader even though they exist. The `Transition` wrapper is what lets `v-show` animate at
 * all: Vue keeps the element displayed until the leave transition has finished, which is the part
 * `v-show` alone cannot do.
 */
import { Search, X } from "@lucide/vue";
import type { Component } from "vue";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

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
    /** What the search field is called, spoken as its accessible label. */
    search: string;
    /** Said under the grid when nothing matches the query. */
    noResults: string;
  };
}>();

const emit = defineEmits<{
  /** Somebody asked for the sheet to go away. */
  close: [];
  /** A tile was clicked: this is the application it names. */
  launch: [id: string];
}>();

/** What the field holds as it is typed, and the query the grid is drawn from. */
const query = ref("");
/** The query the 300ms debounce has agreed on: the grid follows this, not the keystrokes. */
const settledQuery = ref("");
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

const FILTER_DEBOUNCE_MS = 300;

watch(
  () => props.open,
  (open) => {
    // A closed sheet forgets the query: reopening is a new ask, not a continuation of an old one,
    // and a filter somebody cannot see still ruling the grid is a filter gone wrong.
    if (!open) {
      query.value = "";
      settledQuery.value = "";
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      return;
    }
    void nextTick(() => searchField.value?.focus());
  },
);

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
onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  if (debounceTimer !== undefined) {
    clearTimeout(debounceTimer);
  }
});

function onQueryInput(): void {
  if (debounceTimer !== undefined) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    settledQuery.value = query.value;
    debounceTimer = undefined;
  }, FILTER_DEBOUNCE_MS);
}

/** The applications the settled query still names, in the order they were handed over. */
const visibleApps = computed(() => {
  const wanted = settledQuery.value.trim().toLowerCase();
  if (wanted === "") {
    return props.apps;
  }
  return props.apps.filter((app) => app.label.toLowerCase().includes(wanted));
});

const searchField = ref<HTMLInputElement | null>(null);
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

      <!--
        The search field, centred above the grid: 380px is wide enough for a full application name
        plus a typo, and the field is the sheet's first focus so typing starts without a click.
        It exists only while the sheet is open: a closed sheet must not leave an input lying in the
        DOM, where a test — or a browser extension — looking for "the" input would find this one.
      -->
      <div v-if="open" class="starter-search-row">
        <div class="starter-search">
          <Search :size="16" class="starter-search-icon" aria-hidden="true" />
          <input
            ref="searchField"
            v-model="query"
            type="text"
            data-workbench-starter-search
            :placeholder="labels.search"
            :aria-label="labels.search"
            spellcheck="false"
            autocomplete="off"
            @input="onQueryInput()"
          />
        </div>
      </div>

      <p v-if="visibleApps.length === 0" data-workbench-starter-empty class="starter-empty">
        {{ labels.noResults }}
      </p>

      <ul v-else class="starter-grid">
        <li v-for="app in visibleApps" :key="app.id">
          <button
            type="button"
            data-workbench-starter-app
            :data-app-id="app.id"
            class="starter-tile"
            @click="emit('launch', app.id)"
          >
            <span class="starter-plate" :style="{ background: app.tone }">
              <component :is="app.icon" :size="44" />
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
  background: var(--workbench-surface-2);
  opacity: 1;
  /* The layer this sheet is mounted in is click-through while the sheet is closed; the sheet takes
     presses back the moment it is drawn. */
  pointer-events: auto;
}

/*
 * The sheet arrives as the search-oriented sheets do: a slight step down in scale while it fades,
 * over a tenth of a second — fast enough to read as a layer coming forward, not a page changing.
 */
.starter-enter-active,
.starter-leave-active {
  transition:
    opacity var(--wb-dur-fast),
    transform var(--wb-dur-fast);
}

.starter-enter-from,
.starter-leave-to {
  opacity: 0;
  transform: scale(1.1);
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
  color: var(--workbench-on-picture-muted);
  transition:
    background-color var(--wb-dur-base),
    color var(--wb-dur-base);
}

.starter-close:hover,
.starter-close:focus-visible {
  background: var(--workbench-wash-hover);
  color: var(--workbench-on-picture);
}

.starter-close:focus-visible,
.starter-tile:focus-visible,
.starter-search input:focus-visible {
  outline: 1px solid var(--workbench-focus-outline);
  outline-offset: -1px;
}

.starter-search-row {
  display: flex;
  justify-content: center;
  padding: 44px 0 28px;
}

/* The field: 380px of room, on the sheet's own glass, border that brightens as the focus lands. */
.starter-search {
  display: flex;
  width: 380px;
  max-width: calc(100vw - 48px);
  height: 44px;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  border-radius: 8px;
  background: var(--workbench-surface-3);
  color: var(--workbench-on-picture-muted);
}

.starter-search:focus-within {
  outline: 1px solid var(--workbench-focus-outline);
}

.starter-search input {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--workbench-on-picture);
  font-size: 14px;
  outline: none;
}

.starter-search input::placeholder {
  color: var(--workbench-on-picture-muted);
}

.starter-empty {
  padding: 48px 0;
  color: var(--workbench-on-picture-muted);
  font-size: 14px;
  text-align: center;
}

/* The grid: 172px columns the reference's launch sheet uses, centred however wide the desk is. */
.starter-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 172px);
  justify-content: center;
  justify-items: center;
  width: 100%;
  margin: 0;
  padding: 12px 22px 32px;
  list-style: none;
}

.starter-tile {
  display: flex;
  width: 124px;
  height: 116px;
  margin: 7px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 7px;
  transition: background-color var(--wb-dur-base);
  cursor: pointer;
}

.starter-tile:hover {
  background: var(--workbench-wash-hover);
  backdrop-filter: blur(15px);
  -webkit-backdrop-filter: blur(15px);
}

/* The coloured plate keeps the linear icons looking like the reference's stickers. */
.starter-plate {
  display: flex;
  width: 64px;
  height: 64px;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  color: var(--workbench-on-picture);
}

.starter-label {
  max-width: 116px;
  overflow: hidden;
  color: var(--workbench-on-picture);
  font-size: 14px;
  font-weight: 700;
  line-height: 1.2;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
