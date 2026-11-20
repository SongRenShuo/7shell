/**
 * The browser page's leave guard: while bytes are still moving, closing or reloading the tab is a
 * question before it is a loss.
 *
 * This is the hosted side's half of the guard the desktop already has — the workbench pane arms
 * `beforeunload` on the shell's own window, where a closed window is what ends a transfer — and a
 * browser tab has the same shape of risk: a transfer a closed tab abandoned is a transfer nobody
 * can stop or see. The warning is said in the interface's language, with the same sentence the
 * desktop uses, whatever the browser decides to do with it.
 *
 * The desktop shell registers nothing: the guard is a no-op there, because the pane's own guard
 * already owns that window's leave, and two guards on one leave would be two questions about one
 * departure.
 */
import { onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";

import { isDesktopRuntime } from "@/lib/runtime";
import { useFilesStore } from "@/stores/files";

export function useBrowserLeaveGuard(): void {
  if (isDesktopRuntime()) {
    return;
  }
  const { t } = useI18n();
  const files = useFilesStore();

  function onBeforeUnload(event: BeforeUnloadEvent): void {
    if (!files.transfers.some((entry) => entry.state.kind === "running")) {
      return;
    }
    event.preventDefault();
    event.returnValue = t("workbench.desktop.dropUpload.leaveWarning");
  }

  window.addEventListener("beforeunload", onBeforeUnload);
  onBeforeUnmount(() => window.removeEventListener("beforeunload", onBeforeUnload));
}
