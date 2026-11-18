<script setup lang="ts">
/**
 * One floating window on the desktop: the chrome, the gestures, and the slot the application goes
 * in. It owns no window record — position, size, mode and focus all arrive as props — so the same
 * component draws a terminal, a file browser or a monitor page without knowing which it is.
 *
 * The look is the reference desktop's, measured rather than invented: a translucent black pane
 * with a 15px backdrop blur, an 8px radius and a shadow that lets it float over the wallpaper; a
 * title bar at least 45px tall with a 17px white title and a hairline under it; three round icon
 * buttons at the far end, the last of which turns red under the pointer. Everything here stays
 * white on dark, like the rest of the desktop chrome — a window is a thing on a picture, and it
 * does not follow the interface's light theme.
 *
 * The gestures are pointer-based rather than HTML5 drag-and-drop, because a drag is not a data
 * transfer: it starts on the title bar, moves the window by the distance the pointer travelled
 * (always from the geometry the drag began with, so a clamped move cannot make the window drift),
 * and ends on release. Taking the pointer to within 23px of the top edge maximises instead and
 * ends the drag — the status-bar line is the reference's "throw it at the top" target. That line
 * is in viewport coordinates because this component is not told where the desktop begins; a caller
 * whose desktop is nested lower would pass a different threshold.
 *
 * The resize grip in the bottom-right corner is a second, separate gesture: it resizes from the
 * size the drag began with and never starts a title-bar move. It is hidden while maximised, where
 * there is no size to change.
 *
 * Closing is the parent's job. The `closing` prop draws the 200ms collapse; whoever owns the list
 * removes the record once the animation has had its time. Likewise `z`: the parent orders the
 * windows, and passing a `z-index` through the usual style fallthrough is enough because this
 * component has a single root.
 */
import { Copy, Minus, Square, X } from "@lucide/vue";
import type { Component } from "vue";
import { computed, ref } from "vue";

import { MIN_HEIGHT, MIN_WIDTH, STATUS_BAR_HEIGHT, type WindowMode } from "@/lib/workbench/windows";
import { cn } from "@/lib/utils";

const props = defineProps<{
  /** The record this chrome draws. Forwarded to `data-window-id` for the live checks. */
  id: string;
  title: string;
  /** Drawn beside the title when given; a window without one is still a window. */
  icon?: Component;
  state: WindowMode;
  focused: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  /** While true the window is collapsing; the parent removes it after the animation. */
  closing?: boolean;
  /**
   * The three button labels, supplied by the caller so this component imports no translations.
   * The middle one is the restore label while maximised and the maximize label otherwise.
   */
  labels: { minimize: string; maximize: string; restore: string; close: string };
}>();

const emit = defineEmits<{
  /** The window was pressed anywhere: it should come to the front. */
  focus: [];
  close: [];
  minimize: [];
  maximize: [];
  restore: [];
  /** A pointer move during a title-bar drag, in desktop coordinates. */
  move: [{ left: number; top: number }];
  /** A pointer move during a resize, with the minimum already applied. */
  resize: [{ width: number; height: number }];
}>();

const titleBar = ref<HTMLElement | null>(null);
const grip = ref<HTMLElement | null>(null);

/**
 * The drag in progress, or null.
 *
 * Plain object rather than a ref: nothing renders from it, and re-rendering on every pointer move
 * would be work with no pixels to show for it. The starting geometry is kept beside the starting
 * pointer so each emission is an absolute position — the parent may clamp, and a delta accumulated
 * from the previous *emitted* position would then fight the clamp and walk the window away.
 */
let drag: { pointerId: number; startX: number; startY: number; left: number; top: number; maximized: boolean } | null =
  null;

/** The resize in progress, or null; same reasoning as the drag. */
let resize: { pointerId: number; startX: number; startY: number; width: number; height: number } | null = null;

const windowStyle = computed(() => ({
  left: `${props.left}px`,
  top: `${props.top}px`,
  width: `${props.width}px`,
  height: `${props.height}px`,
}));

const rootClass = computed(() =>
  cn(
    "workbench-window absolute flex flex-col overflow-hidden rounded-lg border border-white/10 bg-[#000000c4] text-white shadow-[2px_6px_10px_2px_#00000091] backdrop-blur-[15px]",
    props.state === "max" ? "workbench-window--max rounded-none" : undefined,
    props.state === "min" ? "workbench-window--min" : undefined,
    props.closing ? "workbench-window--closing" : undefined,
    props.focused ? "ring-1 ring-primary/70 ring-inset" : undefined,
  ),
);

/** Whether the middle button offers "restore" rather than "maximize". */
const canRestore = computed(() => props.state === "max");

function onTitlePointerDown(event: PointerEvent): void {
  if (event.button !== 0 || props.state !== "normal" || props.closing) {
    return;
  }
  // A press on one of the three buttons is a press on that button, not the start of a move. The
  // buttons are the only children of the title bar that are not part of the title itself.
  if (event.target instanceof Element && event.target.closest("button") !== null) {
    return;
  }
  event.preventDefault();
  drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    left: props.left,
    top: props.top,
    maximized: false,
  };
  titleBar.value?.setPointerCapture?.(event.pointerId);
}

function onTitlePointerMove(event: PointerEvent): void {
  if (drag === null || event.pointerId !== drag.pointerId) {
    return;
  }
  // The top edge is the desk's status bar: crossing it is the maximise gesture, not a move. It
  // fires once and ends the drag, so a pointer that keeps going does not keep re-maximising.
  if (!drag.maximized && event.clientY <= STATUS_BAR_HEIGHT) {
    drag.maximized = true;
    endDrag(event.pointerId);
    emit("maximize");
    return;
  }
  emit("move", {
    left: drag.left + (event.clientX - drag.startX),
    top: drag.top + (event.clientY - drag.startY),
  });
}

function onTitlePointerUp(event: PointerEvent): void {
  if (drag === null || event.pointerId !== drag.pointerId) {
    return;
  }
  endDrag(event.pointerId);
}

function endDrag(pointerId: number): void {
  titleBar.value?.releasePointerCapture?.(pointerId);
  drag = null;
}

function onGripPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || props.state !== "normal" || props.closing) {
    return;
  }
  // The grip is not inside the title bar, so it cannot start a move; stopping the event keeps it
  // that way if the layout ever puts one inside the other.
  event.preventDefault();
  event.stopPropagation();
  resize = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    width: props.width,
    height: props.height,
  };
  grip.value?.setPointerCapture?.(event.pointerId);
}

function onGripPointerMove(event: PointerEvent): void {
  if (resize === null || event.pointerId !== resize.pointerId) {
    return;
  }
  emit("resize", {
    width: Math.max(MIN_WIDTH, resize.width + (event.clientX - resize.startX)),
    height: Math.max(MIN_HEIGHT, resize.height + (event.clientY - resize.startY)),
  });
}

function onGripPointerUp(event: PointerEvent): void {
  if (resize === null || event.pointerId !== resize.pointerId) {
    return;
  }
  grip.value?.releasePointerCapture?.(event.pointerId);
  resize = null;
}
</script>

<template>
  <!--
    The focus listener is in the capture phase so the window is brought forward before the title
    bar decides whether this press starts a drag: "pressed" and "being moved" are one gesture from
    the person's side, and the raise happens first. It also covers a press in the body, where there
    is no drag at all.
  -->
  <section
    :class="rootClass"
    :style="windowStyle"
    data-workbench-window
    :data-window-id="id"
    :data-window-state="state"
    :aria-hidden="state === 'min' || closing ? 'true' : undefined"
    @pointerdown.capture="emit('focus')"
  >
    <header
      ref="titleBar"
      data-workbench-window-title
      class="flex min-h-[45px] shrink-0 touch-none items-center gap-2 border-b border-[#ffffff12] px-3 select-none"
      @pointerdown="onTitlePointerDown"
      @pointermove="onTitlePointerMove"
      @pointerup="onTitlePointerUp"
      @pointercancel="onTitlePointerUp"
    >
      <component :is="icon" v-if="icon" :size="16" class="shrink-0 text-white/80" aria-hidden="true" />
      <h2 data-workbench-window-caption class="min-w-0 flex-1 truncate text-[17px] leading-none text-white">
        {{ title }}
      </h2>

      <div class="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          data-workbench-window-min
          :aria-label="labels.minimize"
          :title="labels.minimize"
          class="grid h-7 w-7 place-items-center rounded-full text-white/75 transition-colors hover:bg-white/15 hover:text-white focus-visible:ring-1 focus-visible:ring-white/70 focus-visible:outline-none"
          @click="emit('minimize')"
        >
          <Minus :size="19" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-workbench-window-max
          :aria-label="canRestore ? labels.restore : labels.maximize"
          :title="canRestore ? labels.restore : labels.maximize"
          class="grid h-7 w-7 place-items-center rounded-full text-white/75 transition-colors hover:bg-white/15 hover:text-white focus-visible:ring-1 focus-visible:ring-white/70 focus-visible:outline-none"
          @click="canRestore ? emit('restore') : emit('maximize')"
        >
          <Copy v-if="canRestore" :size="19" aria-hidden="true" />
          <Square v-else :size="19" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-workbench-window-close
          :aria-label="labels.close"
          :title="labels.close"
          class="grid h-7 w-7 place-items-center rounded-full text-white/75 transition-colors hover:bg-[#c50f1f] hover:text-white focus-visible:ring-1 focus-visible:ring-white/70 focus-visible:outline-none"
          @click="emit('close')"
        >
          <X :size="19" aria-hidden="true" />
        </button>
      </div>
    </header>

    <!--
      The application goes here. It stays mounted through every mode, including minimised: the
      collapse is a transform, not a `v-if`, because the terminal underneath would lose its buffer
      and the file browser its open channel every time somebody put the window away.
    -->
    <div class="min-h-0 flex-1 overflow-auto">
      <slot />
    </div>

    <!--
      The resize grip: the bottom-right corner, where every desktop has one. Hidden while
      maximised, because a maximised window has no size of its own to change.
    -->
    <span
      v-if="state === 'normal'"
      ref="grip"
      data-workbench-window-grip
      aria-hidden="true"
      class="absolute right-0 bottom-0 z-10 grid h-4 w-4 cursor-nwse-resize touch-none place-items-center"
      @pointerdown="onGripPointerDown"
      @pointermove="onGripPointerMove"
      @pointerup="onGripPointerUp"
      @pointercancel="onGripPointerUp"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" class="pointer-events-none text-white/40">
        <path d="M9 1 1 9M9 5 5 9" stroke="currentColor" stroke-width="1" fill="none" />
      </svg>
    </span>
  </section>
</template>

<style scoped>
/*
 * The three moving modes, all of them transforms so the content underneath is never re-laid out:
 * the opening/moving transition is 200ms, a maximised window takes 300ms because it crosses much
 * more of the screen, and minimised and closing are the two collapses. The transition is on
 * `transform` only — position and size are absolute pixels that a drag changes every pointer move,
 * and transitioning those would make the window lag behind the hand.
 */
.workbench-window {
  transform-origin: center;
  transition: transform 0.2s ease;
  will-change: transform;
}

.workbench-window--max {
  transition-duration: 0.3s;
}

.workbench-window--min {
  transform: scale(0);
  pointer-events: none;
}

.workbench-window--closing {
  transform: scaleY(0);
  pointer-events: none;
  transition-duration: 0.2s;
}
</style>
