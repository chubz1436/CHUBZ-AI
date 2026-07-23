import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneDatabase, toControlPlaneConfig, type M11RuntimeConfiguration } from "@chubz/control-plane";
import type { CodexDispatchCommand } from "@chubz/control-plane";
import type { OutboundConnection, OutboundConnector } from "../src/connection.js";
import { PackagedLocalBridgeRuntime, bridgeSessionAuthorization } from "../src/runtime.js";

const roots: string[] = []; afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const configuration = (root: string): M11RuntimeConfiguration => Object.freeze({ configVersion: 1, controlPlane: Object.freeze({ host: "127.0.0.1", port: 4317, allowedOrigin: "http://127.0.0.1:4317", sessionSecretRef: "environment:CHUBZ_TEST_SESSION_SECRET" }), bridge: Object.freeze({ endpoint: "ws://127.0.0.1:4317/v1/bridge/ws", enrollmentIdentity: "local-bridge", heartbeatIntervalMs: 60_000 }), paths: Object.freeze({ approvedManagedRoots: Object.freeze([root]), managedDataRoot: join(root, "runtime-data"), databaseFile: "control-plane.sqlite", logsDirectory: "operational-logs", supportBundlesDirectory: "support-bundles", packagesDirectory: "release-packages" }), bounds: Object.freeze({ logMaxBytes: 65_536, logRetentionFiles: 2, captureMaxBytes: 65_536, packageMaxBytes: 1_048_576, packageMaxFiles: 100, supportBundleMaxBytes: 1_048_576, supportBundleMaxFiles: 16, storageWarningPercent: 90 }), retention: Object.freeze({ operationalLogDays: 14, resolvedAlertDays: 30, supportBundleDays: 30, packagingStagingHours: 24 }), projects: Object.freeze([]), display: Object.freeze({ productName: "CHUBZ", environmentLabel: "Test" }) });

class FakeConnector implements OutboundConnector {
  public endpoint = ""; public authorization = ""; public messages: string[] = []; public closed = false;
  public connect(endpoint: string, authorization: string): Promise<OutboundConnection> { this.endpoint = endpoint; this.authorization = authorization; return Promise.resolve({ send: (message) => { this.messages.push(message); }, close: () => { this.closed = true; } }); }
}

describe("M11 packaged outbound-only Local Bridge assembly", () => {
  it("wires mandatory approval, journal, isolation, apply, routing, and two-layer emergency gates", async () => {
    const root = mkdtempSync(join(tmpdir(), "chubz-m11-bridge-test-")); roots.push(root); const config = configuration(root); mkdirSync(config.paths.managedDataRoot, { recursive: true }); const secret = "synthetic-session-secret-at-least-thirty-two-bytes"; const database = new ControlPlaneDatabase(toControlPlaneConfig(config, secret, "test")); database.connection.prepare("INSERT INTO administrators(id,username,password_hash,created_at) VALUES('owner','owner','synthetic',?)").run(new Date().toISOString());
    const connector = new FakeConnector(); const runtime = new PackagedLocalBridgeRuntime({ configuration: config, sessionSecret: secret, connector }); expect(runtime.status().assembly).toEqual({ outboundOnly: true, inboundListener: false, journalBeforeExecution: true, approvalGrantRequired: true, adapterIsolated: true, emergencyGateAtBridge: true, emergencyGateAtSpawn: true, applyClaimResultSeparated: true, routingConfirmationRequiredUpstream: true });
    runtime.reconcileAfterRestart(); await runtime.start(); expect(runtime.status().state).toBe("connected"); expect(connector.endpoint).toBe(config.bridge.endpoint); expect(connector.authorization).toBe(bridgeSessionAuthorization(secret)); expect(JSON.parse(connector.messages[0]!)).toMatchObject({ kind: "bridge.heartbeat", emergencyGate: "required" });
    database.connection.prepare("INSERT INTO m8_emergency_stops(stop_id,scope_type,project_id,owner_id,reason,status,activated_at) VALUES('stop-one','project','project-one','owner','synthetic','active',?)").run(new Date().toISOString()); expect(() => runtime.registerAuthorization({ projectId: "project-one" } as CodexDispatchCommand)).toThrow("authoritative emergency stop");
    await runtime.stop(); expect(connector.closed).toBe(true); database.close();
  });

  it("contains no inbound listener and composes the emergency gate into the final spawn supervisor", () => {
    const source = readFileSync(new URL("../src/runtime.ts", import.meta.url), "utf8"); expect(source).toContain("new SqliteEmergencyStopGate"); expect(source).toContain("new ProcessSupervisor"); expect(source).toContain("this.gate"); expect(source).toContain("WebSocketOutboundConnector"); expect(source).not.toMatch(/createServer|\.listen\(|app\.get\(|app\.post\(/u);
  });
});
