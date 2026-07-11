import { describe, expect, it } from "vitest";
import {
  CONNECTOR_TYPES,
  WorkerManifestSchema,
  validateWorkerManifest,
  type WorkerManifest,
} from "../src/index.js";

/** Small test fixture: a plausible CLI worker (not a real production manifest). */
const cliWorker = (): Record<string, unknown> => ({
  workerId: "codex",
  displayName: "Codex",
  provider: "OpenAI",
  runtime: "codex-cli",
  connector: {
    type: "cli-headless",
    invocation: {
      executable: "codex",
      args: ["exec", "--sandbox", "workspace-write"],
      promptDelivery: "argument",
    },
    healthCheck: "version-invocation",
    timeoutPolicy: { timeoutSec: 1800, killGraceSec: 10 },
    cancelable: true,
  },
  capabilities: ["code-write", "review"],
  restrictions: ["assigned-only"],
  allowedTaskCategories: ["implementation", "review"],
  defaultRiskLevel: "medium",
  contextLimits: { maxFiles: 200, maxBytes: 5_000_000 },
  supportedFileOps: ["read", "write-workspace"],
  requiredApprovals: ["integrate"],
  provenanceMode: "automated",
});

/** Small test fixture: an owner-attested manual-relay reviewer. */
const manualWorker = (): Record<string, unknown> => ({
  workerId: "bantay",
  displayName: "Bantay",
  provider: "OpenAI ChatGPT",
  runtime: "manual",
  connector: {
    type: "manual-relay",
    healthCheck: "manual-attestation",
    timeoutPolicy: { timeoutSec: 86_400, killGraceSec: 0 },
    cancelable: false,
  },
  capabilities: ["review", "design", "text-output"],
  restrictions: ["never-write", "manual-import-only"],
  allowedTaskCategories: ["review", "design"],
  defaultRiskLevel: "low",
  contextLimits: { maxFiles: 50, maxBytes: 1_000_000 },
  supportedFileOps: ["read"],
  requiredApprovals: [],
  provenanceMode: "owner-attested",
});

/** Small test fixture: a plausible local-process worker. */
const localProcessWorker = (): Record<string, unknown> => ({
  ...cliWorker(),
  workerId: "local-daemon",
  displayName: "Local Daemon Worker",
  runtime: "local-daemon",
  connector: {
    type: "local-process",
    invocation: { executable: "daemon.exe", args: ["--serve"], promptDelivery: "stdin" },
    healthCheck: "process-ping",
    timeoutPolicy: { timeoutSec: 3600, killGraceSec: 15 },
    cancelable: true,
  },
});

/** Small test fixture: a plausible API worker. */
const apiWorker = (): Record<string, unknown> => ({
  ...cliWorker(),
  workerId: "api-reviewer",
  displayName: "API Reviewer",
  runtime: "provider-api",
  connector: {
    type: "http-api",
    healthCheck: "http-ping",
    timeoutPolicy: { timeoutSec: 600, killGraceSec: 0 },
    cancelable: true,
  },
  capabilities: ["review", "text-output"],
  restrictions: ["never-write"],
  supportedFileOps: ["read"],
});

describe("valid manifests", () => {
  it("accepts a valid CLI worker", () => {
    const result = validateWorkerManifest(cliWorker());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.manifest.workerId).toBe("codex");
      expect(result.manifest.connector.type).toBe("cli-headless");
    }
  });

  it("accepts a valid owner-attested manual-relay worker", () => {
    const result = validateWorkerManifest(manualWorker());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.manifest.provenanceMode).toBe("owner-attested");
      expect(result.manifest.connector.cancelable).toBe(false);
    }
  });

  it("accepts a valid local-process worker", () => {
    expect(validateWorkerManifest(localProcessWorker()).valid).toBe(true);
  });

  it("accepts a valid API worker", () => {
    expect(validateWorkerManifest(apiWorker()).valid).toBe(true);
  });

  it("supports all five planned connector categories in the enum", () => {
    expect([...CONNECTOR_TYPES]).toEqual([
      "cli-headless",
      "http-api",
      "local-process",
      "manual-relay",
      "browser-controlled",
    ]);
  });
});

describe("missing and invalid fields", () => {
  it.each([
    "workerId",
    "displayName",
    "provider",
    "runtime",
    "connector",
    "capabilities",
    "restrictions",
    "allowedTaskCategories",
    "defaultRiskLevel",
    "contextLimits",
    "supportedFileOps",
    "requiredApprovals",
    "provenanceMode",
  ])("rejects a manifest missing required field '%s'", (field) => {
    const candidate = cliWorker();
    delete candidate[field];
    expect(validateWorkerManifest(candidate).valid).toBe(false);
  });

  it("rejects an invalid connector type", () => {
    const candidate = cliWorker();
    (candidate.connector as Record<string, unknown>).type = "telepathy";
    const result = validateWorkerManifest(candidate);
    expect(result.valid).toBe(false);
  });

  it("rejects an invalid risk level", () => {
    const candidate = cliWorker();
    candidate.defaultRiskLevel = "extreme";
    expect(validateWorkerManifest(candidate).valid).toBe(false);
  });

  it("rejects invalid timeout values", () => {
    for (const timeoutSec of [0, -5, 1.5, 100_000]) {
      const candidate = cliWorker();
      (candidate.connector as { timeoutPolicy: { timeoutSec: number } }).timeoutPolicy.timeoutSec =
        timeoutSec;
      expect(validateWorkerManifest(candidate).valid).toBe(false);
    }
  });

  it("rejects invalid context limits", () => {
    for (const bad of [
      { maxFiles: 0, maxBytes: 1000 },
      { maxFiles: 10, maxBytes: 0 },
      { maxFiles: 999_999, maxBytes: 1000 },
      { maxFiles: 10, maxBytes: 2_000_000_000 },
    ]) {
      const candidate = cliWorker();
      candidate.contextLimits = bad;
      expect(validateWorkerManifest(candidate).valid).toBe(false);
    }
  });

  it("rejects malformed worker ids", () => {
    for (const workerId of ["Codex", "codex worker", "-codex", "", "worker_1"]) {
      const candidate = cliWorker();
      candidate.workerId = workerId;
      expect(validateWorkerManifest(candidate).valid).toBe(false);
    }
  });

  it("rejects duplicate list entries", () => {
    const candidate = cliWorker();
    candidate.capabilities = ["review", "review"];
    expect(validateWorkerManifest(candidate).valid).toBe(false);
  });
});

describe("contradictory declarations", () => {
  it("rejects a cancelable manual-relay worker", () => {
    const candidate = manualWorker();
    (candidate.connector as Record<string, unknown>).cancelable = true;
    const result = validateWorkerManifest(candidate);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((i) => i.path === "connector.cancelable")).toBe(true);
    }
  });

  it("rejects a manual-relay worker claiming automated provenance", () => {
    const candidate = manualWorker();
    candidate.provenanceMode = "automated";
    expect(validateWorkerManifest(candidate).valid).toBe(false);
  });

  it("rejects a manual-relay worker declaring write-workspace file ops", () => {
    const candidate = manualWorker();
    candidate.supportedFileOps = ["read", "write-workspace"];
    candidate.restrictions = ["manual-import-only"];
    expect(validateWorkerManifest(candidate).valid).toBe(false);
  });

  it("rejects a manual-relay worker with an invocation", () => {
    const candidate = manualWorker();
    (candidate.connector as Record<string, unknown>).invocation = {
      executable: "chatgpt",
      args: [],
      promptDelivery: "stdin",
    };
    expect(validateWorkerManifest(candidate).valid).toBe(false);
  });

  it("rejects a CLI worker without an invocation", () => {
    const candidate = cliWorker();
    delete (candidate.connector as Record<string, unknown>).invocation;
    expect(validateWorkerManifest(candidate).valid).toBe(false);
  });

  it("rejects a CLI worker claiming owner-attested provenance", () => {
    const candidate = cliWorker();
    candidate.provenanceMode = "owner-attested";
    expect(validateWorkerManifest(candidate).valid).toBe(false);
  });

  it("rejects never-write combined with code-write or write-workspace", () => {
    const withCapability = cliWorker();
    withCapability.restrictions = ["never-write"];
    expect(validateWorkerManifest(withCapability).valid).toBe(false);

    const withFileOp = manualWorker();
    withFileOp.capabilities = ["review"];
    withFileOp.supportedFileOps = ["write-workspace"];
    expect(validateWorkerManifest(withFileOp).valid).toBe(false);
  });

  it("rejects 'none' combined with other file operations", () => {
    const candidate = manualWorker();
    candidate.supportedFileOps = ["none", "read"];
    expect(validateWorkerManifest(candidate).valid).toBe(false);
  });
});

/** Small test fixture: a plausible future browser-controlled worker. */
const browserWorker = (): Record<string, unknown> => ({
  ...cliWorker(),
  workerId: "browser-agent",
  displayName: "Browser Agent",
  runtime: "browser-automation",
  connector: {
    type: "browser-controlled",
    healthCheck: "none",
    timeoutPolicy: { timeoutSec: 1200, killGraceSec: 10 },
    cancelable: true,
  },
  capabilities: ["review", "text-output"],
  restrictions: ["never-write"],
  supportedFileOps: ["read"],
});

describe("automated connector provenance (D-022)", () => {
  it("accepts browser-controlled with automated provenance", () => {
    expect(validateWorkerManifest(browserWorker()).valid).toBe(true);
  });

  it.each(["cli-headless", "local-process", "http-api", "browser-controlled"])(
    "rejects '%s' with owner-attested provenance",
    (type) => {
      const candidate =
        type === "browser-controlled"
          ? browserWorker()
          : type === "http-api"
            ? apiWorker()
            : type === "local-process"
              ? localProcessWorker()
              : cliWorker();
      candidate.provenanceMode = "owner-attested";
      const result = validateWorkerManifest(candidate);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.issues.some((i) => i.path === "provenanceMode")).toBe(true);
      }
    },
  );

  it("manual relay remains the only owner-attested connector", () => {
    expect(validateWorkerManifest(manualWorker()).valid).toBe(true);
  });
});

describe("cross-field hardening (correction 7)", () => {
  it("rejects an API worker claiming owner-attested manual provenance", () => {
    const candidate = apiWorker();
    candidate.provenanceMode = "owner-attested";
    const result = validateWorkerManifest(candidate);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((i) => i.path === "provenanceMode")).toBe(true);
    }
  });

  it("rejects manual-import-only combined with automated workspace writing", () => {
    const candidate = cliWorker();
    candidate.restrictions = ["manual-import-only"];
    const result = validateWorkerManifest(candidate);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.some((i) => i.path === "restrictions")).toBe(true);
    }
  });

  it("still accepts manual-import-only on a manual-relay worker", () => {
    expect(validateWorkerManifest(manualWorker()).valid).toBe(true);
  });
});

describe("deep immutability (correction 6)", () => {
  it("every nested object and array of a parsed manifest is frozen", () => {
    const parsed = WorkerManifestSchema.parse(cliWorker());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.capabilities)).toBe(true);
    expect(Object.isFrozen(parsed.restrictions)).toBe(true);
    expect(Object.isFrozen(parsed.allowedTaskCategories)).toBe(true);
    expect(Object.isFrozen(parsed.supportedFileOps)).toBe(true);
    expect(Object.isFrozen(parsed.requiredApprovals)).toBe(true);
    expect(Object.isFrozen(parsed.contextLimits)).toBe(true);
    expect(Object.isFrozen(parsed.connector)).toBe(true);
    expect(Object.isFrozen(parsed.connector.timeoutPolicy)).toBe(true);
    expect(Object.isFrozen(parsed.connector.invocation)).toBe(true);
    expect(Object.isFrozen(parsed.connector.invocation?.args)).toBe(true);
  });

  it("mutation attempts on nested structures throw", () => {
    const parsed = WorkerManifestSchema.parse(cliWorker());
    expect(() => {
      (parsed.capabilities as unknown as string[]).push("design");
    }).toThrow(TypeError);
    expect(() => {
      (parsed.connector.invocation?.args as unknown as string[]).push("--unsafe");
    }).toThrow(TypeError);
    expect(() => {
      (parsed.connector.timeoutPolicy as { timeoutSec: number }).timeoutSec = 999_999;
    }).toThrow(TypeError);
    expect(() => {
      (parsed.contextLimits as { maxBytes: number }).maxBytes = 0;
    }).toThrow(TypeError);
  });

  it("the caller's original input object is neither frozen nor mutated", () => {
    const input = cliWorker();
    const inputSnapshot = JSON.parse(JSON.stringify(input)) as unknown;
    const parsed = WorkerManifestSchema.parse(input);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.connector)).toBe(false);
    expect(
      Object.isFrozen((input.connector as { invocation: { args: string[] } }).invocation.args),
    ).toBe(false);
    expect(input).toEqual(inputSnapshot);
    // And the input stays independently mutable after parsing.
    input.displayName = "still mutable";
    expect(parsed.displayName).toBe("Codex");
  });

  it("validateWorkerManifest results are deeply frozen too", () => {
    const result = validateWorkerManifest(manualWorker());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(Object.isFrozen(result.manifest.capabilities)).toBe(true);
      expect(Object.isFrozen(result.manifest.connector)).toBe(true);
    }
  });
});

describe("credential rejection", () => {
  it.each(["apiKey", "token", "secret", "password", "credentials", "authToken"])(
    "rejects a manifest carrying a credential-like field '%s' (strict schema)",
    (field) => {
      const candidate = cliWorker();
      candidate[field] = "sk-super-secret-value";
      const result = validateWorkerManifest(candidate);
      expect(result.valid).toBe(false);
    },
  );

  it("rejects credential-like fields nested in the connector", () => {
    const candidate = cliWorker();
    (candidate.connector as Record<string, unknown>).apiKey = "sk-nested";
    expect(validateWorkerManifest(candidate).valid).toBe(false);
  });

  it("rejects credential-like fields nested in the invocation", () => {
    const candidate = cliWorker();
    (
      (candidate.connector as Record<string, unknown>).invocation as Record<string, unknown>
    ).token = "abc";
    expect(validateWorkerManifest(candidate).valid).toBe(false);
  });
});

describe("schema/type agreement", () => {
  it("a parsed manifest satisfies the inferred type", () => {
    const parsed: WorkerManifest = WorkerManifestSchema.parse(cliWorker());
    expect(parsed.connector.timeoutPolicy.timeoutSec).toBe(1800);
  });

  it("validateWorkerManifest reports machine-readable issue paths", () => {
    const candidate = cliWorker();
    candidate.defaultRiskLevel = "extreme";
    const result = validateWorkerManifest(candidate);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]).toHaveProperty("path");
      expect(result.issues[0]).toHaveProperty("message");
    }
  });
});
