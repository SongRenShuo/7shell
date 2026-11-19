/**
 * Acting on the desktop a handover link named.
 *
 * Kept beside the fragment's parsing rather than inside the shell component, so the two rules a
 * deep link lives by are testable on their own: a target the vault knows opens as that session's
 * tab — the ordinary open, which decides the shape the session's protocol opens as — and a
 * target it does not know is one failure notice in the notification centre, with the application
 * staying exactly where it already was.
 */

import { useNotificationsStore } from "@/stores/notifications";
import { useSessionsStore } from "@/stores/sessions";
import { useTerminalsStore } from "@/stores/terminals";

/**
 * Opens the desktop the link asked for, or records that there was nothing to open.
 *
 * `open` is the id `consumeHandoverLink` answered with; null means the link carried no desktop
 * target, which is the ordinary startup of a tab opened without one. The id is matched against
 * the library as it stands when the call is made — which is why the shell makes the call only
 * once the library is on screen.
 */
export async function openHandoverTarget(open: string | null): Promise<void> {
  if (open === null) {
    return;
  }
  const session = useSessionsStore().sessions.find((entry) => entry.id === open);
  if (session === undefined) {
    useNotificationsStore().push({
      source: "browser",
      titleKey: "workbench.notices.deepLink.missing",
      params: { id: open },
    });
    return;
  }
  await useTerminalsStore().open(session);
}
