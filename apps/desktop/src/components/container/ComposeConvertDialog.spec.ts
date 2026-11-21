/**
 * The run→compose dialog: what it shows for one container, and the promises it keeps.
 *
 * The conversion is read-only — the spec feeds the inspect, and the only backend call that may
 * happen is that one read. What is checked is what a lazy dialog would do: claim completeness
 * while parameters went unexpressed, offer a snippet that never made it to the clipboard, or
 * leave a failed read standing as an empty box.
 */
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  containerInspect: vi.fn(),
}));

import ComposeConvertDialog from "@/components/container/ComposeConvertDialog.vue";
import { containerInspect } from "@/lib/backend/tauri";
import { i18n } from "@/i18n";
import type { ContainerSession } from "@/stores/container";
import type { ContainerDetail, ContainerSummary } from "@/types/container";

const inspectMock = vi.mocked(containerInspect);

let app: App | undefined;
let host: HTMLDivElement | undefined;

const SUMMARY: ContainerSummary = {
  id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  name: "web-app",
  image: "nginx:latest",
  state: "running",
  status: "Up 2 hours",
  ports: "8080:80/tcp",
  createdAt: "now",
};

function session(): ContainerSession {
  return {
    connectionId: "conn-1",
    runtime: "docker",
    namespace: "default",
    containers: [SUMMARY],
    images: [],
    namespaces: [],
    loading: false,
    refreshing: false,
    imagesLoading: false,
    error: null,
    info: null,
    tasks: [],
    eventsStreamId: null,
    eventsDegraded: false,
  };
}

function detailOf(raw: unknown): ContainerDetail {
  return {
    id: SUMMARY.id,
    name: SUMMARY.name,
    image: SUMMARY.image,
    state: "running",
    status: "Up 2 hours",
    oomKilled: false,
    pid: 1234,
    restartPolicy: "always",
    ports: [{ hostIp: "", hostPort: "8080", containerPort: "80", protocol: "tcp" }],
    mounts: [{ source: "/srv/data", destination: "/var/www", readOnly: false }],
    env: ["NGINX_PORT=80"],
    raw: JSON.stringify(raw),
  };
}

async function mount(): Promise<void> {
  app = createApp({
    render: () => h(ComposeConvertDialog, { open: true, session: session(), target: SUMMARY }),
  });
  app.use(i18n);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
}

function textarea(): HTMLTextAreaElement {
  const field = document.querySelector<HTMLTextAreaElement>("[data-convert-yml]");
  if (!field) {
    throw new Error("the dialog drew no snippet");
  }
  return field;
}

beforeEach(() => {
  inspectMock.mockReset();
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

describe("the conversion dialog", () => {
  it("reads the container once and shows the snippet it made", async () => {
    inspectMock.mockResolvedValue(
      detailOf({
        HostConfig: {
          RestartPolicy: { Name: "always" },
          PortBindings: { "80/tcp": [{ HostIp: "", HostPort: "8080" }] },
          AutoRemove: true,
        },
        Config: { Env: ["NGINX_PORT=80"] },
      }),
    );
    await mount();

    await vi.waitFor(() => {
      expect(inspectMock).toHaveBeenCalledWith("conn-1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(textarea().value).toContain("services:");
    });
    const snippet = textarea().value;
    expect(snippet).toContain("web-app:");
    expect(snippet).toContain("image: nginx:latest");
    expect(snippet).toContain("restart: always");
    expect(snippet).toContain('- "8080:80/tcp"');
    expect(snippet).toContain("- /srv/data:/var/www");
    expect(snippet).toContain("- NGINX_PORT=80");
    // The read is the only call the dialog makes: nothing restarts, nothing is created.
    expect(inspectMock).toHaveBeenCalledTimes(1);
  });

  it("lists the parameters the snippet could not express, and says so when there are none", async () => {
    inspectMock.mockResolvedValue(detailOf({ HostConfig: { AutoRemove: true } }));
    await mount();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-convert-unresolved]")?.textContent).toContain("AutoRemove");
    });
    expect(document.querySelector("[data-convert-unresolved]")?.textContent).toContain("HostConfig.AutoRemove = true");

    app?.unmount();
    host?.remove();
    inspectMock.mockResolvedValue(detailOf({ HostConfig: {}, Config: {} }));
    await mount();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-convert-unresolved]")?.textContent).toContain(
        "Every inspect parameter found its way into the snippet",
      );
    });
  });

  it("copies the snippet to the clipboard", async () => {
    inspectMock.mockResolvedValue(detailOf({}));
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async (text: string) => written.push(text)) },
      configurable: true,
    });
    await mount();
    await vi.waitFor(() => {
      expect(textarea().value).not.toBe("");
    });

    (document.querySelector("[data-convert-copy]") as HTMLElement)?.click();
    await settle();
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("services:");
    expect(document.body.textContent).toContain("Copied");
  });

  it("says what the inspect refused instead of drawing an empty box", async () => {
    inspectMock.mockRejectedValue(new Error("the engine went away"));
    await mount();
    await settle();
    expect(document.querySelector("[data-convert-failure]")?.textContent).toBeTruthy();
    expect(document.querySelector("[data-convert-yml]")).toBeNull();
  });
});

async function settle(): Promise<void> {
  await nextTick();
  await nextTick();
}
