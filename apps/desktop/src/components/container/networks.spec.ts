/**
 * The networks page's own readings and refusals: the name rule, the address shapes the form
 * refuses, and the filter. The full address grammar is the engine's; what is pinned here is that
 * nothing a valid network could be named is refused, and nothing the engine would bounce is waved
 * through.
 */
import { describe, expect, it } from "vitest";

import { filterNetworks, isValidCidr, isValidGateway, isValidNetworkName } from "./networks";

describe("network names", () => {
  it("accepts the names Docker's own grammar allows", () => {
    expect(isValidNetworkName("bridge")).toBe(true);
    expect(isValidNetworkName("mem-net-test")).toBe(true);
    expect(isValidNetworkName("host_1.example")).toBe(true);
    expect(isValidNetworkName("2net")).toBe(true);
  });

  it("refuses what the engine would bounce", () => {
    expect(isValidNetworkName("-leading")).toBe(false);
    expect(isValidNetworkName("with space")).toBe(false);
    expect(isValidNetworkName("")).toBe(false);
    expect(isValidNetworkName("a".repeat(65))).toBe(false);
  });
});

describe("subnets in CIDR form", () => {
  it("accepts the shapes an engine would take", () => {
    expect(isValidCidr("172.62.0.0/24")).toBe(true);
    expect(isValidCidr("10.0.0.0/8")).toBe(true);
    expect(isValidCidr("0.0.0.0/0")).toBe(true);
    expect(isValidCidr("fd00:dead:beef::/64")).toBe(true);
    expect(isValidCidr("2001:db8::/32")).toBe(true);
  });

  it("refuses what is not an address and prefix", () => {
    expect(isValidCidr("172.62.0.0")).toBe(false);
    expect(isValidCidr("172.62.0.0/")).toBe(false);
    expect(isValidCidr("/24")).toBe(false);
    expect(isValidCidr("172.62.0.0/33")).toBe(false);
    expect(isValidCidr("172.62.999.0/24")).toBe(false);
    expect(isValidCidr("half/24")).toBe(false);
    expect(isValidCidr("fd00::/129")).toBe(false);
    expect(isValidCidr("fd00:not-hex::/64")).toBe(false);
  });
});

describe("gateways", () => {
  it("accepts an address of either family, without a prefix", () => {
    expect(isValidGateway("172.62.0.1")).toBe(true);
    expect(isValidGateway("fd00::1")).toBe(true);
  });

  it("refuses what is not an address", () => {
    expect(isValidGateway("172.62.0.1/24")).toBe(false);
    expect(isValidGateway("172.62.999.1")).toBe(false);
    expect(isValidGateway("gateway")).toBe(false);
    expect(isValidGateway("")).toBe(false);
  });
});

describe("filtering", () => {
  const NETWORKS = [{ name: "bridge" }, { name: "host" }, { name: "mem-net-test" }];

  it("keeps everything when the filter is empty", () => {
    expect(filterNetworks(NETWORKS, "")).toHaveLength(3);
    expect(filterNetworks(NETWORKS, "   ")).toHaveLength(3);
  });

  it("keeps the names that carry the text, in the order they came in", () => {
    expect(filterNetworks(NETWORKS, "NET").map((network) => network.name)).toEqual(["mem-net-test"]);
    expect(filterNetworks(NETWORKS, "hos").map((network) => network.name)).toEqual(["host"]);
  });
});
