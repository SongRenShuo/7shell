/**
 * The notification centre's own ledger: what joins it, what counts as unread, what a session has
 * read, and how the sources announce themselves exactly once.
 *
 * The panel's suite says what the rows look like; this one says what the rows are. The transfer
 * source is driven through the same polled list the panel draws — a reassignment of the files
 * store's list is the event — because "announced once" is a claim about watching that list, not
 * about a call.
 */
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamEndListeners: ((payload: { streamId: string; error?: string }) => void)[] = [];

vi.mock("@/lib/backend/tauri", () => ({
  onContainerStreamEnd: vi.fn(async (listener: (payload: { streamId: string; error?: string }) => void) => {
    streamEndListeners.push(listener);
    return () => {};
  }),
}));

import { useFilesStore } from "@/stores/files";
import { NOTICE_LIMIT, READ_LIMIT, useNotificationsStore, type WorkbenchNotice } from "@/stores/notifications";
import { useTailStore } from "@/stores/tail";
import type { TransferInfo } from "@/types/session";

/** A transfer as the backend's list answers it, with only the fields this store reads varying. */
function transfer(
  id: string,
  state: TransferInfo["state"],
  direction: TransferInfo["direction"] = "upload",
): TransferInfo {
  return {
    id,
    direction,
    name: `archive-${id}.tar`,
    remotePath: `/root/archive-${id}.tar`,
    sessionId: "desk-1",
    size: 100,
    transferred: 100,
    state,
    hasLocalPath: false,
    packed: false,
    pausable: true,
  };
}

const SID = "desk-1";

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  streamEndListeners.length = 0;
});

afterEach(() => {
  localStorage.clear();
});

describe("the ledger", () => {
  it("joins each notice at the front, and never re-sorts the ones already there", () => {
    const centre = useNotificationsStore();
    const first = centre.push({ source: "power", titleKey: "a" });
    const second = centre.push({ source: "power", titleKey: "b" });

    expect(centre.notices.map((notice: WorkbenchNotice) => notice.titleKey)).toEqual(["b", "a"]);
    expect(centre.notices[1]?.id).toBe(first.id);
    expect(centre.notices[0]?.id).toBe(second.id);
  });

  it("holds a bounded list, dropping the oldest off the back", () => {
    const centre = useNotificationsStore();
    const keep = centre.push({ source: "power", titleKey: "oldest" });
    for (let index = 0; index < NOTICE_LIMIT - 2; index += 1) {
      centre.push({ source: "power", titleKey: `n${index}` });
    }
    const latest = centre.push({ source: "power", titleKey: "newest" });

    expect(centre.notices).toHaveLength(NOTICE_LIMIT);
    expect(centre.notices.at(-1)?.id).toBe(keep.id);
    expect(centre.notices[0]?.id).toBe(latest.id);
  });

  it("carries when the notice happened", () => {
    const centre = useNotificationsStore();
    const notice = centre.push({ source: "power", titleKey: "a" });

    expect(notice.at).toBeGreaterThan(0);
  });
});

describe("the read marks", () => {
  it("counts a fresh session's notices as unread, and opening the centre clears the count", () => {
    const centre = useNotificationsStore();
    centre.push({ source: "transfer", titleKey: "a" });
    centre.push({ source: "tail", titleKey: "b" });

    expect(centre.unreadCount(SID)).toBe(2);

    centre.markAllRead(SID);
    expect(centre.unreadCount(SID)).toBe(0);
  });

  it("remembers what a session read across a reload, per session", () => {
    const centre = useNotificationsStore();
    const notice = centre.push({ source: "power", titleKey: "a" });
    centre.markAllRead(SID);

    // A second centre, the way a reload builds one: the marks live in the WebView's own storage.
    const reopened = useNotificationsStore();
    expect(reopened.isRead(SID, notice.id)).toBe(true);
    expect(reopened.unreadCount(SID)).toBe(0);
  });

  it("keeps one session's marks apart from another's", () => {
    const centre = useNotificationsStore();
    centre.push({ source: "power", titleKey: "a" });
    centre.markAllRead(SID);

    expect(centre.unreadCount("desk-2")).toBe(1);
  });

  it("holds a bounded memory of read marks, oldest first out", () => {
    const centre = useNotificationsStore();
    const notices: WorkbenchNotice[] = [];
    // More than the list itself could hold: the cap on read marks only bites past READ_LIMIT, but
    // the list cap is what keeps a full centre from marking more than it holds.
    for (let index = 0; index < READ_LIMIT + 20; index += 1) {
      notices.push(centre.push({ source: "power", titleKey: `n${index}` }));
    }
    centre.markAllRead(SID);

    const stored = JSON.parse(localStorage.getItem(`sevenshell-workbench-notices-read:${SID}`) ?? "[]") as string[];
    // The list holds NOTICE_LIMIT rows, so that is what was marked; under the cap.
    expect(stored).toHaveLength(NOTICE_LIMIT);
    expect(stored.length).toBeLessThanOrEqual(READ_LIMIT);
    // The rows the cap trimmed were never seen, and the newest survived.
    expect(stored).not.toContain(notices[0]!.id);
    expect(stored).toContain(notices.at(-1)!.id);
  });

  it("clears the rows but keeps the record of what was seen", () => {
    const centre = useNotificationsStore();
    const notice = centre.push({ source: "power", titleKey: "a" });
    centre.markAllRead(SID);

    centre.clear();
    expect(centre.notices).toHaveLength(0);
    expect(centre.isRead(SID, notice.id)).toBe(true);
  });
});

describe("the transfer source", () => {
  it("announces a transfer that moved into done, exactly once", async () => {
    const centre = useNotificationsStore();
    const files = useFilesStore();
    centre.connect();

    files.transfers = [transfer("t1", { kind: "running" })];
    await nextTick();
    expect(centre.notices).toHaveLength(0);

    files.transfers = [transfer("t1", { kind: "done" })];
    await nextTick();
    expect(centre.notices).toHaveLength(1);
    expect(centre.notices[0]?.titleKey).toBe("workbench.notices.transfer.doneUpload");
    expect(centre.notices[0]?.params).toEqual({ name: "archive-t1.tar" });
    expect(centre.notices[0]?.target).toBe("transfers");

    // The same list again — the poll's answer unchanged — must not announce it twice.
    files.transfers = [transfer("t1", { kind: "done" })];
    await nextTick();
    expect(centre.notices).toHaveLength(1);
  });

  it("announces a failure in the transfer's own direction, including one it never saw moving", async () => {
    const centre = useNotificationsStore();
    const files = useFilesStore();
    centre.connect();

    files.transfers = [transfer("t2", { kind: "failed", detail: "broken" }, "download")];
    await nextTick();

    expect(centre.notices).toHaveLength(1);
    expect(centre.notices[0]?.titleKey).toBe("workbench.notices.transfer.failedDownload");
  });
});

describe("the tail source", () => {
  it("announces a followed stream that ended, with the file's own path", async () => {
    const centre = useNotificationsStore();
    const tail = useTailStore();
    centre.connect();

    tail.tails = {
      "w-log": {
        tailId: "t1",
        path: "/var/log/syslog",
        lines: [],
        error: null,
        failure: null,
        status: "following",
        requested: 200,
        sessionId: SID,
      },
    };
    await nextTick();
    expect(centre.notices).toHaveLength(0);

    tail.tails["w-log"]!.status = "ended";
    await nextTick();
    expect(centre.notices).toHaveLength(1);
    expect(centre.notices[0]?.titleKey).toBe("workbench.notices.tail.ended");
    expect(centre.notices[0]?.params).toMatchObject({ path: "/var/log/syslog" });

    tail.tails["w-log"]!.status = "ended";
    await nextTick();
    expect(centre.notices).toHaveLength(1);
  });

  it("says so when the stream ended badly", async () => {
    const centre = useNotificationsStore();
    const tail = useTailStore();
    centre.connect();

    tail.tails = {
      "w-log": {
        tailId: "t1",
        path: "/var/log/syslog",
        lines: [],
        error: "the file is gone",
        failure: null,
        status: "following",
        requested: 200,
        sessionId: SID,
      },
    };
    tail.tails["w-log"]!.status = "ended";
    await nextTick();

    expect(centre.notices).toHaveLength(1);
    expect(centre.notices[0]?.titleKey).toBe("workbench.notices.tail.failed");
    expect(centre.notices[0]?.params).toMatchObject({ error: "the file is gone" });
  });
});

describe("the container source", () => {
  it("announces a stream end as it arrives, and says so when it ended badly", async () => {
    const centre = useNotificationsStore();
    centre.connect();
    // The subscription is made asynchronously; let it land before the events are fired.
    await vi.waitFor(() => {
      expect(streamEndListeners.length).toBeGreaterThan(0);
    });

    streamEndListeners[0]!({ streamId: "s1" });
    expect(centre.notices).toHaveLength(1);
    expect(centre.notices[0]?.titleKey).toBe("workbench.notices.container.ended");

    streamEndListeners[0]!({ streamId: "s2", error: "container stopped" });
    expect(centre.notices).toHaveLength(2);
    expect(centre.notices[0]?.titleKey).toBe("workbench.notices.container.failed");
  });

  it("subscribes once, however many times the pane asks", async () => {
    const centre = useNotificationsStore();
    centre.connect();
    await vi.waitFor(() => {
      expect(streamEndListeners.length).toBeGreaterThan(0);
    });

    centre.connect();
    expect(streamEndListeners).toHaveLength(1);
  });
});
