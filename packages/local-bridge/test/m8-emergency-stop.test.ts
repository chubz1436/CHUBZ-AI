import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestConfig } from "@chubz/control-plane";
import { ControlPlaneDatabase } from "@chubz/control-plane";
import { SqliteEmergencyStopGate } from "../src/emergency-stop.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "chubz-m8-bridge-test-")); roots.push(root); const config = createTestConfig(root); const database = new ControlPlaneDatabase(config); database.connection.prepare("INSERT INTO administrators(id,username,password_hash,created_at) VALUES('owner','owner','hash',?)").run(new Date().toISOString()); database.connection.pragma("busy_timeout=1"); return { database, config, gate: new SqliteEmergencyStopGate(config.databasePath) }; };
const activate = (database: ControlPlaneDatabase, stopId: string, scopeType: "global" | "project", projectId: string | null) => database.connection.prepare("INSERT INTO m8_emergency_stops(stop_id,scope_type,project_id,owner_id,reason,status,activated_at) VALUES(?,?,?,?,?,'active',?)").run(stopId, scopeType, projectId, "owner", "test stop", new Date().toISOString());

describe("M8 Bridge emergency-stop enforcement", () => {
  it("fails closed for active project and global stops while preserving unrelated project scope", () => {
    const value = fixture(); activate(value.database, "stop-project", "project", "project-one");
    expect(() => value.gate.assertAllowed("project-one")).toThrow("emergency stop"); expect(() => value.gate.assertAllowed("project-two")).not.toThrow();
    value.database.connection.prepare("UPDATE m8_emergency_stops SET status='released',released_at=? WHERE stop_id='stop-project'").run(new Date().toISOString()); activate(value.database, "stop-global", "global", null);
    expect(() => value.gate.assertAllowed("project-one")).toThrow("emergency stop"); expect(() => value.gate.assertAllowed("project-two")).toThrow("emergency stop"); value.gate.close(); value.database.close();
  });

  it("serializes authoritative activation against the final pre-spawn check and blocks every spawn after activation commits", () => {
    const value = fixture(); let spawns = 0;
    expect(value.gate.runBeforeSpawn("project-race", "operation-before", () => { spawns += 1; expect(() => activate(value.database, "stop-racing", "project", "project-race")).toThrow(/locked/u); return "spawned"; })).toBe("spawned");
    expect(spawns).toBe(1); activate(value.database, "stop-racing", "project", "project-race");
    expect(() => value.gate.runBeforeSpawn("project-race", "operation-after", () => { spawns += 1; })).toThrow("blocked"); expect(spawns).toBe(1);
    value.gate.close(); const reopened = new SqliteEmergencyStopGate(value.config.databasePath); expect(() => reopened.runBeforeSpawn("project-race", "operation-restart", () => { spawns += 1; })).toThrow("blocked"); expect(spawns).toBe(1); reopened.close(); value.database.close();
  });

  it("fails closed when authoritative emergency-stop state cannot be queried", () => {
    const value = fixture(); value.database.connection.exec("DROP TABLE m8_emergency_stops"); expect(() => value.gate.assertAllowed("project-one")).toThrow("unavailable"); value.gate.close(); value.database.close();
  });
});
