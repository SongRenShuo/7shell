/**
 * The networks page's own readings and refusals, in one place so the spec can question them.
 *
 * The name rule is Docker's own grammar for a network. The address rules are lighter than an
 * address parser: the engine — and behind it the Docker CLI — has the last word on a subnet or a
 * gateway, so what the form refuses here is what no engine would ever accept — a shape that is not
 * an address at all — while everything arguable travels and is judged by the side that owns it.
 */

/** Docker's own name rule, shared with the container names: it starts, and stops at the dot. */
const NETWORK_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** How long a name the CLI itself would carry. */
const MAX_NETWORK_NAME_CHARS = 64;

/** Whether a network name is one the engine would accept. */
export function isValidNetworkName(name: string): boolean {
  return name.length <= MAX_NETWORK_NAME_CHARS && NETWORK_NAME_PATTERN.test(name);
}

/** An IPv4 dotted quad, every octet a number it could actually be. */
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(value: string): boolean {
  const match = IPV4_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  return match.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * An IPv6 address, by shape rather than by full grammar: groups of hex separated by colons, at
 * most one run of `::` standing for what was elided. Full validation belongs to the engine; the
 * form only refuses what is not an address in any reading.
 */
function isIpv6Shape(value: string): boolean {
  if (!value.includes(":") || value.includes(":::")) {
    return false;
  }
  const double = value.split("::");
  if (double.length > 2) {
    return false;
  }
  const groups = double.flatMap((side) => side.split(":"));
  const filled = groups.filter((group) => group !== "");
  if (filled.length === 0) {
    // Nothing but the elided run: the bare `::` is an address, a lone `:` is not.
    return double.length === 2;
  }
  // A group that is not hex is not an address in any reading; the empty groups are what the
  // elision leaves at its edges.
  return filled.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group));
}

/**
 * A subnet in CIDR form: an address, a slash, and a prefix length the address family allows. Both
 * families are accepted, because a network may be an IPv6 one.
 */
export function isValidCidr(value: string): boolean {
  const slash = value.lastIndexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    return false;
  }
  const address = value.slice(0, slash);
  const prefix = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefix)) {
    return false;
  }
  const bits = Number(prefix);
  if (value.includes(":")) {
    return isIpv6Shape(address) && bits <= 128;
  }
  return isIpv4(address) && bits <= 32;
}

/** A gateway: an address of either family, no prefix. */
export function isValidGateway(value: string): boolean {
  return value.includes(":") ? isIpv6Shape(value) : isIpv4(value);
}

/** The networks a text filter leaves, by name, in the order the engine gave them. */
export function filterNetworks<T extends { name: string }>(networks: readonly T[], text: string): T[] {
  const needle = text.trim().toLowerCase();
  if (needle === "") {
    return [...networks];
  }
  return networks.filter((network) => network.name.toLowerCase().includes(needle));
}
