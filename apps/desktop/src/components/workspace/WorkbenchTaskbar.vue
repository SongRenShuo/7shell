<script setup lang="ts">
/**
 * The floating pill along the bottom of the desktop: the starter, the running applications, the
 * clock and the power control.
 *
 * Like the rest of the desktop's chrome it carries no state. The entries are handed in — one per
 * window the session has open, with the one in front already marked — and the four things a person
 * can do here are announced rather than performed: open the starter, bring an application forward,
 * open the clock, ask about power. Whoever assembled the desktop decides what those mean.
 *
 * The metrics are the reference's, not the theme's: a 57px pill inset 73px from either side and 15px
 * off the floor, a 12px radius, a 5px blur under a black wash, and 49px cells. The blur and the wash
 * are what let the wallpaper show through without making the labels unreadable, which is the whole
 * reason the bar is glass rather than a solid strip.
 */
import { LayoutGrid, Power } from "@lucide/vue";
import type { Component } from "vue";

defineProps<{
  /** The windows this session has open, in the order the bar draws them. */
  entries: {
    id: string;
    label: string;
    icon: Component;
    /** The colour of the plate behind the icon. */
    tone: string;
    /** Whether this is the window in front. */
    active: boolean;
  }[];
  /** The time, already formatted by the owner; the bar adds no clock of its own. */
  clock: string;
  /** What the power control is called. */
  power: string;
  labels: {
    /** What the grid button is called. */
    starter: string;
    /** What the clock button is called, since the time alone does not say what it opens. */
    clock: string;
  };
}>();

const emit = defineEmits<{
  /** An application's cell was clicked: bring this window forward. */
  launch: [id: string];
  /** The clock was clicked. */
  clock: [];
  /** The power control was clicked. */
  power: [];
  /** The starter cell was clicked. */
  starter: [];
}>();
</script>

<template>
  <div data-workbench-taskbar class="taskbar">
    <!--
      The wash and the blur are one layer of their own so the contents stay crisp: a backdrop filter
      on the same element that holds the text also blurs the text in some engines.
    -->
    <div class="taskbar-mask" aria-hidden="true"></div>

    <div class="taskbar-content">
      <button
        type="button"
        data-workbench-taskbar-starter
        class="taskbar-cell"
        :title="labels.starter"
        :aria-label="labels.starter"
        @click="emit('starter')"
      >
        <LayoutGrid :size="30" />
      </button>

      <button
        v-for="entry in entries"
        :key="entry.id"
        type="button"
        data-workbench-taskbar-entry
        :data-entry-id="entry.id"
        :data-active="entry.active ? 'true' : undefined"
        class="taskbar-cell taskbar-entry"
        :title="entry.label"
        :aria-label="entry.label"
        @click="emit('launch', entry.id)"
      >
        <span class="taskbar-plate" :style="{ background: entry.tone }">
          <component :is="entry.icon" :size="20" />
        </span>
        <!-- The running mark: a red dot that scales in under the window in front. -->
        <span class="taskbar-dot" :class="{ 'is-active': entry.active }" aria-hidden="true"></span>
      </button>

      <span class="taskbar-spacer"></span>

      <button
        type="button"
        data-workbench-taskbar-clock
        class="taskbar-clock"
        :title="labels.clock"
        :aria-label="labels.clock"
        @click="emit('clock')"
      >
        {{ clock }}
      </button>

      <button
        type="button"
        data-workbench-taskbar-power
        class="taskbar-power"
        :title="power"
        :aria-label="power"
        @click="emit('power')"
      >
        <Power :size="16" />
        <span>{{ power }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/*
 * One step above the starter's 20, which is the reference's ordering said locally: the bar stays
 * reachable while the sheet is open, so the starter's own cell can close it again.
 */
.taskbar {
  position: relative;
  z-index: 30;
  display: flex;
  height: 57px;
  flex: none;
  margin: 0 73px 15px;
  overflow: hidden;
  border-radius: 12px;
  box-shadow: 0 2px 10px #00000069;
  user-select: none;
}

.taskbar-mask {
  position: absolute;
  inset: 0;
  background: #00000082;
  backdrop-filter: blur(5px);
  -webkit-backdrop-filter: blur(5px);
}

.taskbar-content {
  position: relative;
  z-index: 1;
  display: flex;
  height: 100%;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  color: #ffffff;
}

.taskbar-cell {
  display: flex;
  width: 49px;
  height: 49px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  transition: background-color 0.3s;
  cursor: pointer;
}

.taskbar-cell:hover,
.taskbar-clock:hover,
.taskbar-power:hover {
  background: #484646bd;
}

.taskbar-cell:focus-visible,
.taskbar-clock:focus-visible,
.taskbar-power:focus-visible {
  outline: 1px solid #ffffffa0;
  outline-offset: -1px;
}

.taskbar-entry {
  position: relative;
  flex-direction: column;
}

/* The plate is the entry's 32px picture: the icon inside it is smaller so the colour still reads. */
.taskbar-plate {
  display: flex;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  color: #ffffff;
}

/*
 * The reference puts the dot at 42px from the top of a 49px cell, which is just under the icon.
 * Scale rather than width/height, so the mark grows into place instead of reflowing the cell.
 */
.taskbar-dot {
  position: absolute;
  top: 42px;
  left: 50%;
  width: 5px;
  height: 5px;
  margin-left: -2.5px;
  border-radius: 50%;
  background: #d11010f5;
  transform: scale(0);
  transition: transform 0.5s;
}

.taskbar-dot.is-active {
  transform: scale(1);
}

.taskbar-spacer {
  flex: 1;
}

.taskbar-clock {
  display: flex;
  height: 49px;
  flex: none;
  align-items: center;
  padding: 0 10px;
  border-radius: 3px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  transition: background-color 0.3s;
  cursor: pointer;
}

.taskbar-power {
  display: flex;
  height: 49px;
  flex: none;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  border-radius: 3px;
  font-size: 13px;
  transition: background-color 0.3s;
  cursor: pointer;
}
</style>
