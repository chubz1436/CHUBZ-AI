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
