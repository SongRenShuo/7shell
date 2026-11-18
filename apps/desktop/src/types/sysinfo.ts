/**
 * What the system panel reads, from `sevenshell_types::sysinfo`.
 *
 * Every one of these comes from a fixed read-only command, so nothing here is a value anybody
 * typed into a shell. The shapes mirror the Rust types field for field (camelCase all the way
 * down, which the contract test pins).
 */

export interface ServiceEntry {
  readonly name: string;
  readonly load: string;
  readonly active: string;
  readonly sub: string;
  readonly description: string;
}

export interface DiskDevice {
  readonly name: string;
  readonly size: string;
  readonly kind: string;
  readonly mount?: string;
  readonly model?: string;
  readonly filesystem?: string;
  readonly children: readonly DiskDevice[];
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

export interface SystemOverview {
  readonly services: readonly ServiceEntry[];
  readonly disks: readonly DiskDevice[];
  readonly accounts: readonly AccountEntry[];
  readonly interfaces: readonly InterfaceEntry[];
  readonly routes: readonly RouteEntry[];
  readonly dns: readonly string[];
  readonly distribution?: string;
  readonly kernel?: string;
  readonly uptimeSeconds: number;
  readonly timezone?: string;
}
