<script setup lang="ts">
/**
 * One floating window on the desktop: the chrome, the gestures, and the slot the application goes
 * in. It owns no window record — position, size, mode and focus all arrive as props — so the same
 * component draws a terminal, a file browser or a monitor page without knowing which it is.
 *
 * The look is the reference desktop's, measured rather than invented, and named in the workbench
 * token block of `globals.css` rather than written here: the pane is `--workbench-panel` (the
 * Semi panel treatment — a solid face on the host theme, glass again over a wallpaper, because a
 * window is where people read on the host and part of the picture over one), its edge a 1px
 * low-alpha `--workbench-glass-border`, its shadow the app tier of the `--wb-shadow-*` scale
 * (the Semi three-layer recipe), and its roundness `--wb-radius-window` — the window step of the
 * desktop's own radius scale, still derived from the corner style the rest of the interface obeys.
 * A title bar 44px tall (the reference's own HEADER_HEIGHT) with a 17px title and a hairline under
 * it; three round icon buttons at the far end, the last of which turns `--workbench-danger` with
 * the fixed white pair as its text under the pointer. The face follows the host's theme — a dark
 * application base and light text on a dark host, white on a light one — except where it must not:
 * on a wallpaper the pane re-points the whole chrome at the fixed white pair
 * (`data-workbench-on-picture` in `globals.css`), because text standing on a picture is always
 * white — the panel rides the theme, the words on the picture do not. Nothing here names a colour
 * of its own.
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
 * there is no size to change. Beside it, the eight edge and corner zones every desktop manager
 * draws do the same work from any edge: each starts the same directional gesture, which measures
 * from the geometry the drag began with and hands the pane a proposed rectangle tagged with the
 * edge it was measured from — the arithmetic that keeps the far edge anchored lives in
 * `resizeWindowFrom`, not here. The grip stays, because a corner grip is also the affordance that
 * says "this can be resized" without anybody having to hunt for an edge.
 *
 * Closing is the parent's job. The `closing` prop draws the 200ms collapse; whoever owns the list
 * removes the record once the animation has had its time. Likewise `z`: the parent orders the
 * windows, and passing a `z-index` through the usual style fallthrough is enough because this
 * component has a single root.
 */
import { Copy, Minus, Square, X } from "@lucide/vue";
import type { Component } from "vue";
import { computed, ref } from "vue";

import {
  MIN_HEIGHT,
  MIN_WIDTH,
  type ResizeDirection,
  type WindowMode,
  type WorkbenchWindowRect,
} from "@/lib/workbench/windows";
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
  /**
   * Where the pointer itself is, in desktop coordinates, while a drag is under way. The window's
   * own rectangle says where the window is; the snap zones are judged by the hand, which may be
   * holding the title bar anywhere along it.
   */
  moveAt: [{ left: number; top: number }];
  /** A pointer move during a resize, with the minimum already applied. */
  resize: [{ width: number; height: number }];
  /**
   * A pointer move during a directional resize: the rectangle the pointer has travelled to,
   * measured from the geometry the drag began with, tagged with the edge it was measured from.
   * The minimum and the desk's edges are the arithmetic's business (`resizeWindowFrom`), not this
   * gesture's.
   */
  resizeDir: [{ dir: ResizeDirection; rect: WorkbenchWindowRect }];
  /** The title-bar drag ended with the pointer let go: the moment a snap, if one was pending, lands. */
  moveEnd: [];
}>();

const titleBar = ref<HTMLElement | null>(null);
const grip = ref<HTMLElement | null>(null);
const windowEl = ref<HTMLElement | null>(null);

/**
 * The drag in progress, or null.
 *
 * Plain object rather than a ref: nothing renders from it, and re-rendering on every pointer move
 * would be work with no pixels to show for it. The starting geometry is kept beside the starting
 * pointer so each emission is an absolute position — the parent may clamp, and a delta accumulated
 * from the previous *emitted* position would then fight the clamp and walk the window away.
 */
let drag: {
  pointerId: number;
  startX: number;
  startY: number;
  left: number;
  top: number;
  maximized: boolean;
  /** Where the hand holds the window, so the pointer's desktop position travels with the moves. */
  grabX: number;
  grabY: number;
} | null = null;

/** The resize in progress, or null; same reasoning as the drag. */
let resize: {
  pointerId: number;
  startX: number;
  startY: number;
  /** The geometry the drag began with — every emission measures from it, never from the last one. */
  anchor: WorkbenchWindowRect;
  /** The edge the drag started from; the bottom-right grip is the "se" of this same gesture. */
  dir: ResizeDirection;
  /** The zone the pointer was captured on, so the capture is released where it was taken. */
  element: HTMLElement | null;
} | null = null;

/**
 * The eight edge and corner zones, drawn as thin strips along the window's edges. Each carries the
 * cursor the direction is named by; the corners are 8px squares where two strips would overlap.
 * They are hidden while maximised along with the grip, and they sit under the grip in the corner
 * it shares, so the grip keeps the corner it has always had.
 */
const RESIZE_ZONES: ReadonlyArray<{ dir: ResizeDirection; class: string }> = [
  { dir: "n", class: "top-0 right-2 left-2 h-2 cursor-n-resize" },
  { dir: "s", class: "bottom-0 right-2 left-2 h-2 cursor-s-resize" },
  { dir: "e", class: "top-2 right-0 bottom-2 w-2 cursor-e-resize" },
  { dir: "w", class: "top-2 left-0 bottom-2 w-2 cursor-w-resize" },
  { dir: "ne", class: "top-0 right-0 h-2 w-2 cursor-ne-resize" },
  { dir: "nw", class: "top-0 left-0 h-2 w-2 cursor-nw-resize" },
  { dir: "se", class: "bottom-0 right-0 h-2 w-2 cursor-se-resize" },
  { dir: "sw", class: "bottom-0 left-0 h-2 w-2 cursor-sw-resize" },
];

const windowStyle = computed(() => ({
  left: `${props.left}px`,
  top: `${props.top}px`,
  width: `${props.width}px`,
  height: `${props.height}px`,
}));

const rootClass = computed(() =>
  cn(
    "workbench-window absolute flex flex-col overflow-hidden rounded-wb-window border border-[var(--workbench-glass-border)] bg-[var(--workbench-panel)] text-[var(--workbench-on-picture)] shadow-[var(--wb-shadow-app)] backdrop-blur-[15px]",
    props.state === "max" ? "workbench-window--max rounded-none" : undefined,
    props.state === "min" ? "workbench-window--min" : undefined,
    props.closing ? "workbench-window--closing" : undefined,
    props.focused ? "ring-1 ring-inset ring-[color-mix(in_srgb,var(--workbench-accent)_70%,transparent)]" : undefined,
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
  // The hand's own offset inside the window, measured off the window's on-screen rectangle: the
  // pointer's desktop position is the window's position plus this, which is what the pane judges
  // its snap zones by.
  const rect = windowEl.value?.getBoundingClientRect?.();
  drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    left: props.left,
    top: props.top,
    maximized: false,
    grabX: rect === undefined ? 0 : event.clientX - rect.left,
    grabY: rect === undefined ? 0 : event.clientY - rect.top,
  };
  titleBar.value?.setPointerCapture?.(event.pointerId);
}

/**
 * The double-click habit every window manager teaches: two presses on the title bar are the
 * maximize button's other face. It coexists with the drag because a double-click's two pointerdowns
 * move nothing — a drag that never moved has nothing to undo when the second press completes.
 */
function onTitleDoubleClick(): void {
  if (props.state === "max") {
    emit("restore");
  } else if (props.state === "normal") {
    emit("maximize");
  }
}

function onTitlePointerMove(event: PointerEvent): void {
  if (drag === null || event.pointerId !== drag.pointerId) {
    return;
  }
  const nextTop = drag.top + (event.clientY - drag.startY);
  // The work area's own top edge is the maximise gesture, not a move. The window's coordinates are
  // the caller's frame — the shell measures the region between its status bar and taskbar — so the
  // line is where this window's top would reach zero, not where the pointer is on the screen: a
  // desktop nested under the application's chrome has no viewport edge of its own to aim at. It
  // fires once and ends the drag, so a pointer that keeps going does not keep re-maximising.
  if (!drag.maximized && nextTop <= 0) {
    drag.maximized = true;
    endDrag(event.pointerId);
    emit("maximize");
    return;
  }
  emit("move", {
    left: drag.left + (event.clientX - drag.startX),
    top: nextTop,
  });
  emit("moveAt", {
    left: drag.left + (event.clientX - drag.startX) + drag.grabX,
    top: nextTop + drag.grabY,
  });
}

function onTitlePointerUp(event: PointerEvent): void {
  if (drag === null || event.pointerId !== drag.pointerId) {
    return;
  }
  // The drag ended with the pointer let go — the moment a pending snap, if the pane saw one, is
  // meant to land. A drag that ended in the maximise gesture has already cleared itself, and this
  // line never runs for it.
  emit("moveEnd");
  endDrag(event.pointerId);
}

function endDrag(pointerId: number): void {
  titleBar.value?.releasePointerCapture?.(pointerId);
  drag = null;
}

/**
 * Starts a resize from one of the eight edge zones, or from the grip.
 *
 * `element` is the zone the press landed on — the pointer is captured on it, so the moves that
 * follow arrive there no matter where the hand goes, exactly as the title bar captures its drag.
 */
function beginResize(event: PointerEvent, dir: ResizeDirection, element: HTMLElement | null): void {
  if (event.button !== 0 || props.state !== "normal" || props.closing) {
    return;
  }
  // A resize is not inside the title bar, so it cannot start a move; stopping the event keeps it
  // that way if the layout ever puts one inside the other.
  event.preventDefault();
  event.stopPropagation();
  resize = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    anchor: { left: props.left, top: props.top, width: props.width, height: props.height },
    dir,
    element,
  };
  element?.setPointerCapture?.(event.pointerId);
}

/**
 * The rectangle the pointer has travelled to, measured from the drag's own starting geometry.
 *
 * The anchored edge moves with the pointer; the far edge is the anchor's. What the minimum and the
 * desk then do to this rectangle is `resizeWindowFrom`'s answer, not this gesture's.
 */
function proposedRect(dir: ResizeDirection, dx: number, dy: number): WorkbenchWindowRect {
  const anchor = resize!.anchor;
  const rect: WorkbenchWindowRect = { left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height };
  if (dir.includes("e")) {
    rect.width = anchor.width + dx;
  }
  if (dir.includes("s")) {
    rect.height = anchor.height + dy;
  }
  if (dir.includes("w")) {
    rect.width = anchor.width - dx;
    rect.left = anchor.left + dx;
  }
  if (dir.includes("n")) {
    rect.height = anchor.height - dy;
    rect.top = anchor.top + dy;
  }
  return rect;
}

function onResizePointerMove(event: PointerEvent): void {
  if (resize === null || event.pointerId !== resize.pointerId) {
    return;
  }
  const dx = event.clientX - resize.startX;
  const dy = event.clientY - resize.startY;
  if (resize.dir === "se") {
    // The grip's own contract, kept as it has always been: the minimum is applied here, and the
    // pane's `resizeWindow` does the rest.
    emit("resize", {
      width: Math.max(MIN_WIDTH, resize.anchor.width + dx),
      height: Math.max(MIN_HEIGHT, resize.anchor.height + dy),
    });
    return;
  }
  emit("resizeDir", { dir: resize.dir, rect: proposedRect(resize.dir, dx, dy) });
}

function onResizePointerUp(event: PointerEvent): void {
  if (resize === null || event.pointerId !== resize.pointerId) {
    return;
  }
  if (resize.element !== null) {
    resize.element.releasePointerCapture?.(event.pointerId);
  }
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
    ref="windowEl"
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
      class="flex min-h-[44px] shrink-0 touch-none items-center gap-2 border-b border-[var(--workbench-glass-border)] px-3 select-none"
      @pointerdown="onTitlePointerDown"
      @pointermove="onTitlePointerMove"
      @pointerup="onTitlePointerUp"
      @pointercancel="onTitlePointerUp"
      @dblclick="onTitleDoubleClick"
    >
      <component
        :is="icon"
        v-if="icon"
        :size="16"
        class="shrink-0 text-[color-mix(in_srgb,var(--workbench-on-picture)_80%,transparent)]"
        aria-hidden="true"
      />
      <h2
        data-workbench-window-caption
        class="min-w-0 flex-1 truncate text-[17px] leading-none text-[var(--workbench-on-picture)]"
      >
        {{ title }}
      </h2>

      <div class="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          data-workbench-window-min
          :aria-label="labels.minimize"
          :title="labels.minimize"
          class="grid h-7 w-7 place-items-center rounded-full text-[color-mix(in_srgb,var(--workbench-on-picture)_75%,transparent)] transition-colors hover:bg-[var(--workbench-wash-hover)] hover:text-[var(--workbench-on-picture)] focus-visible:ring-1 focus-visible:ring-[var(--workbench-focus-outline)] focus-visible:outline-none"
          @click="emit('minimize')"
        >
          <Minus :size="19" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-workbench-window-max
          :aria-label="canRestore ? labels.restore : labels.maximize"
          :title="canRestore ? labels.restore : labels.maximize"
          class="grid h-7 w-7 place-items-center rounded-full text-[color-mix(in_srgb,var(--workbench-on-picture)_75%,transparent)] transition-colors hover:bg-[var(--workbench-wash-hover)] hover:text-[var(--workbench-on-picture)] focus-visible:ring-1 focus-visible:ring-[var(--workbench-focus-outline)] focus-visible:outline-none"
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
          class="grid h-7 w-7 place-items-center rounded-full text-[color-mix(in_srgb,var(--workbench-on-picture)_75%,transparent)] transition-colors hover:bg-[var(--workbench-danger)] hover:text-[var(--workbench-on-wallpaper)] focus-visible:ring-1 focus-visible:ring-[var(--workbench-focus-outline)] focus-visible:outline-none"
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

      The rounded clip is carried by a shell under the pane rather than by the pane alone. A
      `backdrop-filter`ed element rounding its own corners is where the compositor lets a
      scroller's square corner bleed past the curve — the white block that used to sit on the
      terminal window's bottom-right edge, on top of the scrollbar it was swallowing. One layer
      down, where the paint is plain, `overflow-hidden` clips without argument, so the inner
      scroller keeps its `min-h-0`, its scrollbar falls inside the border and out of the grip's
      corner, and nothing it draws reaches the frame.
    -->
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
      <div class="min-h-0 flex-1 overflow-auto">
        <slot />
      </div>
    </div>

    <!--
      The eight edge and corner zones: thin strips along every edge, each starting the same
      directional resize gesture with the edge it names. They are drawn only while the window is in
      its normal mode, with the grip — a maximised window has no size of its own to change. The
      strips are 8px, wide enough to catch, narrow enough not to eat the content's edge clicks.
    -->
    <template v-if="state === 'normal'">
      <span
        v-for="zone in RESIZE_ZONES"
        :key="zone.dir"
        :data-workbench-resize="zone.dir"
        aria-hidden="true"
        class="absolute z-10 touch-none"
        :class="zone.class"
        @pointerdown="beginResize($event, zone.dir, $event.currentTarget as HTMLElement)"
        @pointermove="onResizePointerMove"
        @pointerup="onResizePointerUp"
        @pointercancel="onResizePointerUp"
      ></span>
    </template>

    <!--
      The resize grip: the bottom-right corner, where every desktop has one. Hidden while
      maximised, because a maximised window has no size of its own to change. The corner zone sits
      under it, so the grip keeps the corner it has always had.
    -->
    <span
      v-if="state === 'normal'"
      ref="grip"
      data-workbench-window-grip
      aria-hidden="true"
      class="absolute right-0 bottom-0 z-10 grid h-4 w-4 cursor-nwse-resize touch-none place-items-center"
      @pointerdown="beginResize($event, 'se', grip)"
      @pointermove="onResizePointerMove"
      @pointerup="onResizePointerUp"
      @pointercancel="onResizePointerUp"
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        class="pointer-events-none text-[color-mix(in_srgb,var(--workbench-on-picture)_40%,transparent)]"
      >
        <path d="M9 1 1 9M9 5 5 9" stroke="currentColor" stroke-width="1" fill="none" />
      </svg>
    </span>
  </section>
</template>

<style scoped>
/*
 * The three moving modes, all of them transforms so the content underneath is never re-laid out:
 * the durations are the desktop's motion tokens — base for the opening/moving transition, slow
 * for a maximise, which crosses much more of the screen, and minimised and closing are the two
 * collapses. The transition is on `transform` only — position and size are absolute pixels that a
 * drag changes every pointer move, and transitioning those would make the window lag behind the
 * hand.
 */
.workbench-window {
  transform-origin: center;
  transition: transform var(--wb-dur-base) var(--wb-ease-out);
  will-change: transform;
  /* The entrance: every window arrives by settling into place rather than by appearing. It runs
     once per mount (the animation, unlike the transition, does not re-fire when geometry changes),
     and it is short enough that a fast double-click never sees a half-drawn window. */
  animation: workbench-window-in var(--wb-dur-fast) var(--wb-ease-out);
}

@keyframes workbench-window-in {
  from {
    opacity: 0.4;
    transform: scale(0.97);
  }

  to {
    opacity: 1;
    transform: scale(1);
  }
}

/* Somebody who told their OS to calm the motion gets a desktop without any of it: the transforms
   above are decoration, and the states (min, closing) still apply instantly. */
@media (prefers-reduced-motion: reduce) {
  .workbench-window {
    transition: none;
    animation: none;
  }
}

.workbench-window--max {
  transition-duration: var(--wb-dur-slow);
}

.workbench-window--min {
  transform: scale(0);
  pointer-events: none;
}

.workbench-window--closing {
  transform: scaleY(0);
  pointer-events: none;
  transition-duration: var(--wb-dur-base);
}
</style>
