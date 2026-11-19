/**
 * The desktop's notification centre: what happened while nobody was looking at the place it
 * happened.
 *
 * The sources are the ones the plan names — transfers finishing or failing (read off the same
 * polled list the transfer panel draws, with this store's own memory of the last state per
 * transfer, so a completion is told exactly once), a followed log's stream ending, a container
 * task's stream ending, the power action's receipt (pushed by the pane that asked), and the
 * browser handover's deep link failing to name a desktop the vault knows. Each
 * notice carries *keys*, not sentences: this store imports no translations, and the panel's owner
 * says what "upload finished" means in the language the interface is speaking.
 *
 * Two cap rules keep the centre honest under load. The list is bounded at {@link NOTICE_LIMIT} and
 * a new notice joins the front (`unshift`-shaped: the existing rows never re-sort, so the panel
 * never redraws everything because one thing happened). The read marks are bounded at
 * {@link READ_LIMIT} per session, oldest dropped first — a read mark for a notice that has left
 * the list is bookkeeping for nothing.
 *
 * Read state is a per-session set in the WebView's own storage, the same place the desktop's other
 * choices live, under the same refusal rule: a WebView that will not hold storage costs the
 * memory, not the centre.
 */
import { defineStore } from "pinia";
import { ref, watch } from "vue";

import { backend } from "@/lib/backend/api";
import { useFilesStore } from "@/stores/files";
import { useTailStore } from "@/stores/tail";
import type { TransferState } from "@/types/session";

/** Where a notice came from, which is also how the panel groups them. */
export type NoticeSource = "transfer" | "container" | "tail" | "power" | "browser";

/** One notice: what happened, in the caller's vocabulary, and where a click on it goes. */
export interface WorkbenchNotice {
  readonly id: string;
  readonly source: NoticeSource;
  /** The i18n key the panel's owner turns into the one-line summary. */
  readonly titleKey: string;
  /** The i18n key for the detail line, when the source has one to give. */
  readonly bodyKey?: string;
  /** The values the two keys are spoken with (a file's name, an error's sentence). */
  readonly params?: Record<string, string>;
  /** When it happened, as an epoch number the owner formats. */
  readonly at: number;
  /** Where a click goes, when the source has a window to open. */
  readonly target?: "transfers";
}

/** How many notices the centre holds; older ones fall off the back. */
export const NOTICE_LIMIT = 200;

/** How many read marks one session's storage holds; the oldest is dropped first. */
export const READ_LIMIT = 400;

function readKey(sessionId: string): string {
  return `sevenshell-workbench-notices-read:${sessionId}`;
}

/** What made a transfer move: the shape this store keys its memory by. */
type TransferKind = TransferState["kind"];

export const useNotificationsStore = defineStore("notifications", () => {
  /** Every notice, newest first. */
  const notices = ref<WorkbenchNotice[]>([]);

  /** The notice ids each session has read, persisted where the desktop's other choices live. */
  const readIds = ref<Record<string, string[]>>({});

  function readStored(sessionId: string): string[] {
    if (readIds.value[sessionId] !== undefined) {
      return readIds.value[sessionId];
    }
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(readKey(sessionId)) ?? "[]");
      const stored = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
      readIds.value = { ...readIds.value, [sessionId]: stored };
      return stored;
    } catch {
      // A WebView that refuses storage costs the memory, not the centre.
      readIds.value = { ...readIds.value, [sessionId]: [] };
      return [];
    }
  }

  function writeStored(sessionId: string): void {
    try {
      const stored = readIds.value[sessionId] ?? [];
      localStorage.setItem(readKey(sessionId), JSON.stringify(stored.slice(-READ_LIMIT)));
    } catch {
      // Same refusal, same answer.
    }
  }

  /** Records that this session has seen one notice, bounded like the list it refers to. */
  function markRead(sessionId: string, id: string): void {
    const stored = readStored(sessionId);
    if (stored.includes(id)) {
      return;
    }
    readIds.value = { ...readIds.value, [sessionId]: [...stored, id].slice(-READ_LIMIT) };
    writeStored(sessionId);
  }

  /**
   * Adds a notice at the front and caps the list.
   *
   * The existing rows keep their order — a new arrival must not re-sort the panel the person is
   * reading — and the cap trims from the back, where the oldest ones live.
   */
  function push(input: Omit<WorkbenchNotice, "id" | "at">): WorkbenchNotice {
    const notice: WorkbenchNotice = { id: crypto.randomUUID(), at: Date.now(), ...input };
    notices.value = [notice, ...notices.value].slice(0, NOTICE_LIMIT);
    return notice;
  }

  /** Whether this session has read the notice. */
  function isRead(sessionId: string, id: string): boolean {
    return readStored(sessionId).includes(id);
  }

  /** How many notices this session has not read, among the ones it is shown. */
  function unreadCount(sessionId: string): number {
    const read = new Set(readStored(sessionId));
    return notices.value.filter((notice) => !read.has(notice.id)).length;
  }

  /** Marks every notice this session can see as read, the way opening the centre does. */
  function markAllRead(sessionId: string): void {
    for (const notice of notices.value) {
      markRead(sessionId, notice.id);
    }
  }

  /** Empties the list. The read marks stay: clearing is about the rows, not about what was seen. */
  function clear(): void {
    notices.value = [];
  }

  // -- the sources ------------------------------------------------------------

  let connected = false;

  /**
   * Subscribes to the store's own sources, once.
   *
   * Transfers are read off the polled list with a memory of the last state per transfer, so a
   * transfer that moves into `done` or `failed` is announced exactly once — including one that
   * arrived already finished before any read saw it moving. The tail store's states answer the
   * same way: a stream whose status lands on `ended` is announced when the change is seen.
   * Container stream-ends arrive as backend events and are announced as they come.
   */
  function connect(): void {
    if (connected) {
      return;
    }
    connected = true;

    const files = useFilesStore();
    const transferKinds = new Map<string, TransferKind>();
    watch(
      () => files.transfers,
      (list) => {
        for (const transfer of list) {
          const previous = transferKinds.get(transfer.id);
          transferKinds.set(transfer.id, transfer.state.kind);
          if (transfer.state.kind !== "done" && transfer.state.kind !== "failed") {
            continue;
          }
          if (previous === transfer.state.kind) {
            continue;
          }
          const ended = transfer.state.kind === "done" ? "done" : "failed";
          const direction = transfer.direction === "upload" ? "Upload" : "Download";
          push({
            source: "transfer",
            titleKey: `workbench.notices.transfer.${ended}${direction}`,
            bodyKey: "workbench.notices.transfer.detail",
            params: { name: transfer.name },
            target: "transfers",
            // sessionId is deliberately not narrowed: a transfer belongs to the session that
            // started it, and the panel shows the centre to the session it is open in.
          });
        }
      },
    );

    const tail = useTailStore();
    const tailStatuses = new Map<string, string>();
    watch(
      // A snapshot rather than the record itself: the tail store mutates its states in place, so a
      // plain watch on the record would not see a status change. Rebuilding the snapshot makes the
      // watcher fire on any tail movement; the per-window status memory is what decides whether
      // the movement is worth a notice.
      () =>
        Object.entries(tail.tails).map((entry) => ({
          id: entry[0],
          status: entry[1].status,
          error: entry[1].error,
          path: entry[1].path,
        })),
      (states) => {
        for (const state of states) {
          const previous = tailStatuses.get(state.id);
          tailStatuses.set(state.id, state.status);
          if (previous === state.status || state.status !== "ended") {
            continue;
          }
          push({
            source: "tail",
            titleKey: state.error !== null ? "workbench.notices.tail.failed" : "workbench.notices.tail.ended",
            bodyKey: state.error !== null ? "workbench.notices.tail.error" : "workbench.notices.tail.detail",
            params: { path: state.path, error: state.error ?? "" },
          });
        }
      },
    );

    void backend.containers.onStreamEnd((payload) => {
      push({
        source: "container",
        titleKey:
          payload.error !== undefined ? "workbench.notices.container.failed" : "workbench.notices.container.ended",
        bodyKey: payload.error !== undefined ? "workbench.notices.container.error" : undefined,
        params: payload.error !== undefined ? { error: payload.error } : undefined,
      });
    });
  }

  return {
    notices,
    readIds,
    push,
    isRead,
    unreadCount,
    markRead,
    markAllRead,
    clear,
    connect,
  };
});
