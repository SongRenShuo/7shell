import { describe, expect, it, vi } from "vitest";

import { ShellError, internalError, noTransportError, normalizeShellError } from "./errors";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));

import { isDesktopRuntime } from "@/lib/runtime";

const envelope = {
  version: 1,
  code: "SSH-HOSTKEY-MISMATCH",
  messageKey: "errors.ssh.hostKeyMismatch",
  messageParams: { host: "host.example", port: "22" },
  origin: { subsystem: "ssh", adapter: "russh", peer: "host.example:22" },
  outcome: "notSent",
  detail: "presented key differs from the trusted key",
  diagnostics: { keyType: "ssh-ed25519" },
};

describe("normalizeShellError", () => {
  it("keeps an envelope from Rust intact", () => {
    const error = normalizeShellError(envelope, "app_info");

    expect(error).toBeInstanceOf(ShellError);
    expect(error.code).toBe("SSH-HOSTKEY-MISMATCH");
    expect(error.messageKey).toBe("errors.ssh.hostKeyMismatch");
    expect(error.messageParams).toMatchObject({ host: "host.example", port: "22" });
    expect(error.outcome).toBe("notSent");
    expect(error.detail).toContain("presented key");
    expect(error.envelope.origin.peer).toBe("host.example:22");
    expect(error.envelope.diagnostics).toMatchObject({ keyType: "ssh-ed25519" });
  });

  it("fills in what a terse producer leaves out", () => {
    const error = normalizeShellError(
      { version: 1, code: "VAULT-LOCKED", messageKey: "errors.vault.locked", origin: { subsystem: "vault" } },
      "app_info",
    );

    expect(error.code).toBe("VAULT-LOCKED");
    expect(error.messageParams).toEqual({});
    expect(error.outcome).toBe("unknown");
    expect(error.detail).toBeUndefined();
    expect(error.envelope.diagnostics).toBeUndefined();
  });

  it("turns a bare rejection into an envelope instead of losing it", () => {
    const fromString = normalizeShellError("connection reset", "load");
    expect(fromString.code).toBe("APP-INTERNAL");
    expect(fromString.detail).toBe("connection reset");
    expect(fromString.messageParams).toMatchObject({ operation: "load" });

    expect(normalizeShellError(new Error("boom"), "load").detail).toBe("boom");
    expect(normalizeShellError(undefined, "load").code).toBe("APP-INTERNAL");
  });

  it("is idempotent", () => {
    const once = normalizeShellError(envelope, "app_info");
    expect(normalizeShellError(once, "app_info")).toBe(once);
  });
});

describe("ShellError", () => {
  it("answers whether anything was sent", () => {
    expect(normalizeShellError(envelope, "app_info").nothingWasSent).toBe(true);
    expect(noTransportError("app_info").nothingWasSent).toBe(true);
    expect(normalizeShellError({ ...envelope, outcome: "sent" }, "app_info").nothingWasSent).toBe(false);
    expect(internalError("boom", "load").nothingWasSent).toBe(false);
  });

  it("stays an Error and reads sensibly", () => {
    const error = noTransportError("app_info");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ShellError);
    expect(error.message).toContain("APP-NO-TRANSPORT");
    expect(error.detail).toBeUndefined();
  });
});

describe("describeShellError", () => {
  it("renders the localized sentence and keeps the code", async () => {
    const { describeShellError } = await import("@/i18n/errors");
    const described = describeShellError(
      (key, params) => `${key}|${params?.host ?? ""}`,
      normalizeShellError(envelope, "app_info"),
    );

    expect(described.message).toBe("errors.ssh.hostKeyMismatch|host.example");
    expect(described.code).toBe("SSH-HOSTKEY-MISMATCH");
    expect(described.detail).toContain("presented key");
  });

  it("falls back to the backend detail when a key has no translation", async () => {
    const { describeShellError } = await import("@/i18n/errors");
    const described = describeShellError((key) => key, internalError("raw failure text", "load"));

    expect(described.message).toBe("raw failure text");
    expect(described.detail).toBeUndefined();
  });
});

describe("backend facade", () => {
  it("answers a call made outside the desktop shell with a real envelope", async () => {
    vi.mocked(isDesktopRuntime).mockReturnValue(false);

    const { backend } = await import("./api");
    await expect(backend.appInfo()).rejects.toMatchObject({ code: "APP-NO-TRANSPORT" });

    vi.mocked(isDesktopRuntime).mockReturnValue(true);
  });
});

describe("the Docker window's error surface", () => {
  /**
   * The Docker window renders every failure through the catalog — the code's own sentence, never
   * a raw string. This pins the codes that surface can raise: the engine's three container codes,
   * the SSH codes an engine-over-SSH fails with, and the policy gate's two. The engine's catalog
   * and this one are compared in both directions by the contract suite; what this adds is the
   * Docker window's own claim — that the codes its actions actually raise are named here, and
   * said in words in both languages.
   */
  const DOCKER_SURFACE: readonly [string, string][] = [
    ["CONTAINER-UNAVAILABLE", "errors.container.unavailable"],
    ["CONTAINER-COMMAND-FAILED", "errors.container.commandFailed"],
    ["CONTAINER-NOT-CONNECTED", "errors.container.notConnected"],
    ["SSH-UNREACHABLE", "errors.ssh.unreachable"],
    ["SSH-TIMEOUT", "errors.ssh.timeout"],
    ["SSH-CHANNEL-FAILED", "errors.ssh.channelFailed"],
    ["SSH-AUTH-FAILED", "errors.ssh.authFailed"],
    ["POLICY-DENIED", "errors.policy.denied"],
    ["POLICY-APPROVAL-REQUIRED", "errors.policy.approvalRequired"],
  ];

  /** Walks a dotted message key down a locale file's nested object. */
  function localeSentence(locale: Record<string, unknown>, key: string): unknown {
    return key.split(".").reduce<unknown>((node, part) => {
      if (node !== null && typeof node === "object") {
        return (node as Record<string, unknown>)[part];
      }
      return undefined;
    }, locale);
  }

  it("maps every code the Docker window can raise to its message key", async () => {
    const { ERROR_CATALOG } = await import("./errorCodes");
    for (const [code, key] of DOCKER_SURFACE) {
      expect(ERROR_CATALOG[code as keyof typeof ERROR_CATALOG], code).toBe(key);
    }
  });

  it("says each of them in words in both languages", async () => {
    const en = (await import("@/i18n/locales/en/errors.json")).default as Record<string, unknown>;
    const zh = (await import("@/i18n/locales/zh-CN/errors.json")).default as Record<string, unknown>;

    for (const [, key] of DOCKER_SURFACE) {
      expect(typeof localeSentence(en, key), `${key} has words in en`).toBe("string");
      expect(typeof localeSentence(zh, key), `${key} has words in zh-CN`).toBe("string");
    }
  });
});
