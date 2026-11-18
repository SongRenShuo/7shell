/**
 * Which desktop widgets somebody keeps on the desk, read and written per session.
 *
 * The widgets are a device-side preference, like the icon density and the window memory: two
 * machines looking at one host may keep different desks, and the choices live in the WebView's own
 * storage keyed by session. A stored id this build does not draw is dropped on read, the way the
 * icon order drops icons whose door is gone; a storage that refuses costs the preference, and the
 * desk falls back to all four widgets.
 */

/** The widgets the desk can draw, in the order the column draws them. */
export const WORKBENCH_WIDGET_IDS = ["system", "cpu", "net", "storage"] as const;

export type WorkbenchWidgetId = (typeof WORKBENCH_WIDGET_IDS)[number];

/** The storage key, namespaced per session the way the hidden doors are. */
const WIDGETS_KEY = "sevenshell-workbench-widgets";

/**
 * What this session keeps on the desk.
 *
 * Every known widget is drawn unless the session's record says otherwise: an absent record is a
 * first visit, and a first visit gets the full column rather than an empty one.
 */
export function readDesktopWidgets(sessionId: string): Set<WorkbenchWidgetId> {
  const enabled = new Set<WorkbenchWidgetId>(WORKBENCH_WIDGET_IDS);
  try {
    const raw = localStorage.getItem(`${WIDGETS_KEY}:${sessionId}`);
    if (raw === null) {
      return enabled;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return enabled;
    }
    const wanted = new Set(parsed.filter((id): id is WorkbenchWidgetId => typeof id === "string"));
    return new Set(WORKBENCH_WIDGET_IDS.filter((id) => wanted.has(id)));
  } catch {
    return enabled;
  }
}

/** Writes one session's widget set down, whole. */
export function writeDesktopWidgets(sessionId: string, enabled: Set<WorkbenchWidgetId>): void {
  try {
    localStorage.setItem(
      `${WIDGETS_KEY}:${sessionId}`,
      JSON.stringify(WORKBENCH_WIDGET_IDS.filter((id) => enabled.has(id))),
    );
  } catch {
    // A storage that refuses costs the preference, not the desktop.
  }
}

/** Whether a usage reading should wear the threshold colour, at the 90/95 the desktops share. */
export function usageTone(percent: number): "ok" | "warn" | "danger" {
  if (percent >= 95) {
    return "danger";
  }
  if (percent >= 90) {
    return "warn";
  }
  return "ok";
}
