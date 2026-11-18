/**
 * What a container's state means, and what colour it is drawn in.
 *
 * The engine reports a state word, and the desktop window draws that state as a light wash of the
 * colour it means — the tag treatment the reference gives its container list. Nine states cover what the
 * engine can report; anything else (a new state, a runtime this build has not met) falls to the
 * neutral tone and its own raw word, because a state nobody named must not be guessed at a colour
 * or at a translation.
 *
 * The mapping is a table rather than a switch, so the suite can drive it: one row per state, and
 * the test reads the table.
 */
import type { WbTagTone } from "@/components/ui/WbTag.vue";

/** A state in the table: the tone its tag is washed with, and where its label lives. */
export interface ContainerStateStyle {
  readonly tone: WbTagTone;
  /** The i18n key under `container.state.` that names the state. */
  readonly labelKey: string;
}

/**
 * The nine states, with the family each belongs to:
 * `running` is the healthy one; `dead` is the failure; the transitions (`starting`, `stopping`,
 * `restarting`, `updating`) and `paused` are the in-betweens; `exited` and `created` are states
 * that are neither good news nor a problem.
 */
export const CONTAINER_STATE_STYLES: Readonly<Record<string, ContainerStateStyle>> = {
  running: { tone: "success", labelKey: "container.state.running" },
  exited: { tone: "neutral", labelKey: "container.state.exited" },
  created: { tone: "neutral", labelKey: "container.state.created" },
  restarting: { tone: "warning", labelKey: "container.state.restarting" },
  paused: { tone: "warning", labelKey: "container.state.paused" },
  dead: { tone: "danger", labelKey: "container.state.dead" },
  updating: { tone: "warning", labelKey: "container.state.updating" },
  starting: { tone: "warning", labelKey: "container.state.starting" },
  stopping: { tone: "warning", labelKey: "container.state.stopping" },
};

/** Every state the table names — the suite walks this list. */
export const CONTAINER_STATES: readonly string[] = Object.keys(CONTAINER_STATE_STYLES);

/** The style for a state: the table's row, or the neutral fallback for a state it does not know. */
export function containerStateStyle(state: string): ContainerStateStyle {
  return CONTAINER_STATE_STYLES[state] ?? { tone: "neutral", labelKey: "" };
}

/**
 * The words a state is drawn with. A state in the table is named by its own entry; a state outside
 * it stays the engine's word, untranslated rather than mistranslated.
 */
export function containerStateLabel(state: string, translate: (key: string) => string): string {
  const style = containerStateStyle(state);
  return style.labelKey === "" ? state : translate(style.labelKey);
}

/**
 * The loading words a write action draws while the engine is doing it — the reference's enumeration, said
 * in the interface's own key space, keyed by the action names the store sends on the wire. Each
 * action's button carries its word; the pair with the state table is deliberate: starting is both
 * what the container is doing and what we are waiting for.
 */
export const CONTAINER_LOADING_KEYS = {
  start: "container.loadingActions.starting",
  stop: "container.loadingActions.stopping",
  restart: "container.loadingActions.restarting",
  rm: "container.loadingActions.removing",
} as const;
