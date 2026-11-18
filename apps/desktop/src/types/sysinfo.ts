/**
 * What the system panel reads, from `sevenshell_types::sysinfo`.
 *
 * Every one of these comes from a fixed read-only command, so nothing here is a value anybody
 * typed into a shell. The shapes mirror the Rust types field for field (camelCase all the way
 * down, which the contract test pins), and the optionality mirrors the Rust side's
 * `skip_serializing_if` one for one: a field the Rust side omits is `?` here, because a mirror
 * that insists it is always there throws on the first real payload that leaves it out.
 */

import type { DiskUsage } from "@/types/monitor";

export interface ServiceEntry {
  readonly name: string;
  readonly load: string;
  readonly active: string;
  readonly sub: string;
  readonly description: string;
  /**
   * The unit file's boot state as `systemctl list-unit-files` spells it — `enabled`, `disabled`,
   * `static`, `masked`, `indirect`, `alias`, `generated`, ….
   *
   * **Absent** when the unit has no entry in that list, and the Rust side omits a `None` on the
   * wire. The list is of unit *files*, so a transient unit has no boot state at all; treating this
   * as always present would either invent `disabled` for it or draw `undefined` in the column.
   */
  readonly enabled?: string;
}

export interface DiskDevice {
  readonly name: string;
  readonly size: string;
  readonly kind: string;
  readonly mount?: string;
  readonly model?: string;
  readonly filesystem?: string;
  /**
   * Partitions and holders. **Absent** rather than empty when there are none — the Rust side omits
   * an empty vector on the wire, and a mirror that insists it is always there is a mirror that
   * throws "not iterable" the first time a leaf device is drawn.
   */
  readonly children?: readonly DiskDevice[];
}

export interface AccountEntry {
  readonly user: string;
  readonly uid: number;
  readonly gid: number;
  readonly shell: string;
  readonly home: string;
  readonly loggedIn: boolean;
  readonly isRoot: boolean;
}

export interface InterfaceAddress {
  readonly family: string;
  readonly address: string;
  readonly prefix: number;
  readonly scope?: string;
}

export interface InterfaceEntry {
  readonly name: string;
  readonly state: string;
  readonly mac?: string;
  readonly addresses: readonly InterfaceAddress[];
  readonly rxBytes: number;
  readonly txBytes: number;
}

export interface RouteEntry {
  readonly destination: string;
  readonly gateway?: string;
  readonly device: string;
  readonly metric?: number;
}

export interface JournalLine {
  readonly at: string;
  readonly unit: string;
  readonly message: string;
}

export interface JournalTail {
  readonly lines: readonly JournalLine[];
  readonly available: boolean;
}

/** One row of the login table `last -n 20 -w` prints. */
export interface LoginRecord {
  /** The account, or `reboot` for the machine's own boot record. */
  readonly user: string;
  /** The terminal, or `system boot` for the boot record. */
  readonly tty: string;
  /**
   * Where the login came from — an address, a hostname, or the kernel release of a boot record.
   * Empty when the host left the column blank, which is how a console login prints.
   */
  readonly from: string;
  /** When the session started, in the host's own words: `Wed Nov 18 10:59`. */
  readonly start: string;
  /**
   * The row's trailing status column as the host printed it: `still logged in`, `still running`,
   * `down (00:01)`, or `11:01 (00:03)` for a session that ended. Kept verbatim rather than parsed
   * into minutes — `last` prints words in that column too, and a normalised value would be this
   * side's vocabulary rather than the host's.
   */
  readonly duration: string;
  /** True while the session is still up: `still logged in`, or a boot record's `still running`. */
  readonly stillLoggedIn: boolean;
}

/** The host's firewall, as far as the two tools on it would say. */
export interface FirewallStatus {
  /** `ufw` or `firewalld`, whichever answered. Empty when neither did — see `installed`. */
  readonly backend: string;
  /**
   * False when neither tool produced an answer, which the page draws as "not installed".
   *
   * The tools say nothing on stdout when the binary is missing *and* when the account may not read
   * their state, so a non-root session on a host that has ufw lands here too — the wording is
   * "no tool answered", not a certainty about what is installed.
   */
  readonly installed: boolean;
  /** `Status: active` for ufw, `running` for firewalld. */
  readonly active: boolean;
  /** The one line the tool printed, in its own wording. */
  readonly detail: string;
}

export interface SystemOverview {
  readonly services: readonly ServiceEntry[];
  readonly disks: readonly DiskDevice[];
  readonly accounts: readonly AccountEntry[];
  readonly interfaces: readonly InterfaceEntry[];
  readonly routes: readonly RouteEntry[];
  readonly dns: readonly string[];
  /**
   * The crontab's job lines, trimmed; comments and blank lines are gone. Always on the wire — an
   * empty list is "this account has no jobs", which is a fact the page writes out.
   */
  readonly crontab: readonly string[];
  /** The last logins `last` printed, newest first. Always on the wire; empty when none are kept. */
  readonly logins: readonly LoginRecord[];
  /**
   * The firewall, or absent when this read never asked — the Rust side omits a `None`. The
   * "asked and no tool is installed" case is a present object with `installed: false`.
   */
  readonly firewall?: FirewallStatus;
  /**
   * The mounted file systems and their usage, from the same `df -kP` the monitor samples. Always
   * on the wire; every row the host listed is sent, and what to draw is the page's decision.
   */
  readonly mounts: readonly DiskUsage[];
  readonly distribution?: string;
  readonly kernel?: string;
  readonly uptimeSeconds: number;
  readonly timezone?: string;
}
