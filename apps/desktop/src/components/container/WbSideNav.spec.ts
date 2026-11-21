/**
 * The rail, as the pane hands it over: rows with counts, the page that is on screen marked, and a
 * badge that clips instead of growing.
 *
 * What is pinned is the contract the Docker window leans on — that a disabled row refuses presses
 * without disappearing, that the active row is announced to a screen reader as well as drawn, and
 * that a count of eleven is drawn as "10+" when the rail clips at ten.
 */
import { type App, createApp, defineComponent, h } from "vue";
import { afterEach, beforeEach, expect, it } from "vitest";

import WbSideNav, { type SideNavItem } from "@/components/container/WbSideNav.vue";

const StubIcon = defineComponent({ render: () => h("span", { "data-stub-nav-icon": "" }) });

const ITEMS: SideNavItem[] = [
  { id: "overview", label: "Overview", icon: StubIcon },
  { id: "containers", label: "Containers", icon: StubIcon, count: 7 },
  { id: "images", label: "Images", icon: StubIcon, count: 11, disabled: true },
];

let app: App | undefined;
let host: HTMLDivElement = document.createElement("div");
let selected: string[] = [];

function mount(items: readonly SideNavItem[] = ITEMS, activeId = "overview"): void {
  app?.unmount();
  host?.remove();
  selected = [];
  app = createApp({
    render() {
      return h(WbSideNav, {
        items,
        activeId,
        label: "Docker",
        onSelect: (id: string) => selected.push(id),
      });
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
}

function row(id: string): HTMLButtonElement {
  const element = host.querySelector(`[data-side-nav-item="${id}"]`);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`the rail has no ${id} row`);
  }
  return element;
}

beforeEach(() => mount());
afterEach(() => {
  app?.unmount();
  host.remove();
});

it("draws one row per page, icon and label", () => {
  const rows = host.querySelectorAll("[data-side-nav-item]");
  expect(rows).toHaveLength(3);
  expect(row("containers").textContent).toContain("Containers");
  expect(host.querySelector("[data-stub-nav-icon]")).not.toBeNull();
});

it("marks the page on screen, for the pointer and for a screen reader", () => {
  expect(row("overview").getAttribute("aria-current")).toBe("page");
  expect(row("overview").className, "the active row sits on the brand-blue light wash").toContain(
    "bg-[color-mix(in_srgb,var(--workbench-accent)_12%,transparent)]",
  );
  expect(row("overview").className, "and carries the 3px blue bar at its left edge").toContain(
    "shadow-[inset_3px_0_0_var(--workbench-accent)]",
  );
  expect(row("containers").getAttribute("aria-current")).toBeNull();
});

it("selects what was clicked", () => {
  row("containers").click();
  expect(selected).toEqual(["containers"]);
});

it("draws a disabled row dimmed and refusing presses, without hiding it", () => {
  const disabled = row("images");
  expect(disabled.getAttribute("aria-disabled")).toBe("true");
  expect(disabled.className).toContain("cursor-not-allowed");

  disabled.click();
  expect(selected).toEqual([]);
});

it("carries a count as a badge", () => {
  const badge = row("containers").querySelector("[data-side-nav-badge]");
  expect(badge?.textContent?.trim()).toBe("7");
  expect(row("overview").querySelector("[data-side-nav-badge]")).toBeNull();
});

it("clips a count that outgrows the rail to N+", () => {
  mount([{ id: "images", label: "Images", icon: StubIcon, count: 39 }]);
  expect(row("images").querySelector("[data-side-nav-badge]")?.textContent?.trim()).toBe("10+");

  mount([{ id: "images", label: "Images", icon: StubIcon, count: 10 }]);
  expect(row("images").querySelector("[data-side-nav-badge]")?.textContent?.trim()).toBe("10");

  mount([{ id: "images", label: "Images", icon: StubIcon, count: 11, disabled: true }]);
  expect(row("images").querySelector("[data-side-nav-badge]")?.textContent?.trim()).toBe("10+");
});

it("keeps the reference measure: the rail is 220px wide", () => {
  expect(host.querySelector("aside")?.className).toContain("w-[220px]");
});

it("names itself for a screen reader", async () => {
  const nav = host.querySelector("nav");
  expect(nav?.getAttribute("aria-label")).toBe("Docker");
});
