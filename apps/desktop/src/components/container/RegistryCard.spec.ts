/**
 * The registry card, as the engine answered it: the mirrors and proxy drawn as facts, the fragment
 * copied and never written, and the three shapes of a daemon that says little.
 */
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  dockerInfo: vi.fn(async () => ({})),
}));

import RegistryCard from "@/components/container/RegistryCard.vue";
import { i18n } from "@/i18n";
import { dockerInfo } from "@/lib/backend/tauri";

const infoMock = vi.mocked(dockerInfo);

let app: App | undefined;
let host: HTMLDivElement | undefined;

async function mount(connectionId: string | null): Promise<void> {
  app = createApp({ render: () => h(RegistryCard, { connectionId }) });
  app.use(i18n);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
}

function card(): HTMLElement {
  const found = document.querySelector("[data-registry-card]");
  if (!(found instanceof HTMLElement)) {
    throw new Error("the registry card is not on the page");
  }
  return found;
}

beforeEach(() => {
  infoMock.mockClear();
  infoMock.mockResolvedValue({});
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

describe("the registry card", () => {
  it("draws the mirrors and the proxy the daemon reported", async () => {
    infoMock.mockResolvedValue({
      mirrors: ["https://docker.gmssh.com/", "https://dockerhub.icu/"],
      httpProxy: "http://proxy.lan:3128",
      httpsProxy: "http://proxy.lan:3128",
      noProxy: "localhost,127.0.0.1",
    });
    await mount("conn-1");

    await vi.waitFor(() => expect(infoMock).toHaveBeenCalledWith("conn-1"));
    await vi.waitFor(() => {
      const text = card().textContent ?? "";
      expect(text).toContain("https://docker.gmssh.com/");
      expect(text).toContain("https://dockerhub.icu/");
      expect(text).toContain("http://proxy.lan:3128");
      expect(text).toContain("localhost,127.0.0.1");
    });
  });

  it("copies the facts as the fragment a daemon configuration would carry", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    infoMock.mockResolvedValue({
      mirrors: ["https://docker.gmssh.com/"],
      httpsProxy: "http://proxy.lan:3128",
    });
    await mount("conn-1");

    await vi.waitFor(() => {
      const button = card().querySelector("[data-registry-copy]");
      expect(button).not.toBeNull();
    });
    (card().querySelector("[data-registry-copy]") as HTMLElement)?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    const fragment = JSON.parse(String(writeText.mock.calls[0]?.[0]));
    expect(fragment).toEqual({
      "registry-mirrors": ["https://docker.gmssh.com/"],
      proxies: { "https-proxy": "http://proxy.lan:3128" },
    });
  });

  it("offers no fragment for a daemon configured with neither mirrors nor proxy", async () => {
    await mount("conn-1");
    await vi.waitFor(() => expect(infoMock).toHaveBeenCalled());
    await nextTick();
    expect(card().querySelector("[data-registry-copy]")).toBeNull();
    expect(card().textContent).toContain("No mirror or proxy is configured");
  });

  it("says what the engine's silence means, instead of an empty card", async () => {
    infoMock.mockRejectedValue({ code: "CONTAINER-UNAVAILABLE" });
    await mount("conn-1");
    await vi.waitFor(() => expect(card().textContent).toContain("did not answer"));
  });

  it("reads nothing when there is no engine to ask", async () => {
    await mount(null);
    await nextTick();
    expect(infoMock).not.toHaveBeenCalled();
    expect(card().textContent).toContain("No mirror or proxy is configured");
  });
});
