import type { ApiError, Snapshot } from "./types.js";

let csrfToken = "";
export const setCsrfToken = (value: string): void => { csrfToken = value; };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.method && init.method !== "GET") {
    headers.set("Content-Type", "application/json");
    headers.set("X-CSRF-Token", csrfToken);
  }
  const response = await fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  const body = response.status === 204 ? null : await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const error = new Error(typeof body?.["error"] === "object" && body["error"] !== null ? String((body["error"] as Record<string, unknown>)["message"] ?? "The request failed.") : "The request failed.") as ApiError;
    error.status = response.status;
    error.code = typeof body?.["error"] === "object" && body["error"] !== null ? String((body["error"] as Record<string, unknown>)["code"] ?? "ERROR") : "ERROR";
    throw error;
  }
  return body as T;
}

export async function loadSnapshot(): Promise<Snapshot> {
  const snapshot = await request<Snapshot>("/v1/ui/snapshot");
  setCsrfToken(snapshot.csrfToken);
  return snapshot;
}

export const login = (username: string, password: string): Promise<{ csrfToken: string }> => request("/v1/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
export const logout = (): Promise<null> => request("/v1/auth/logout", { method: "POST", body: "{}" });
export const createTask = (body: Record<string, unknown>): Promise<Record<string, unknown>> => request("/v1/ui/tasks", { method: "POST", body: JSON.stringify(body) });
export const mutateTask = (taskId: string, action: "approve-dispatch" | "cancel" | "decision" | "manual-text" | "manual-artifacts" | "captures", body: Record<string, unknown>): Promise<Record<string, unknown>> => request(`/v1/ui/tasks/${encodeURIComponent(taskId)}/${action}`, { method: "POST", body: JSON.stringify(body) });
export const activateEmergencyStop = (body: Record<string, unknown>): Promise<Record<string, unknown>> => request("/v1/ui/emergency-stops", { method: "POST", body: JSON.stringify(body) });
export const releaseEmergencyStop = (stopId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => request(`/v1/ui/emergency-stops/${encodeURIComponent(stopId)}/release`, { method: "POST", body: JSON.stringify(body) });
export const rebuildBridgeLog = (body: Record<string, unknown>): Promise<Record<string, unknown>> => request("/v1/ui/bridge-log/rebuild", { method: "POST", body: JSON.stringify(body) });
export const acknowledgeIncident = (incidentId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => request(`/v1/ui/recovery-incidents/${encodeURIComponent(incidentId)}/acknowledge`, { method: "POST", body: JSON.stringify(body) });
export const checkApplyEligibility = (body: Record<string, unknown>): Promise<Record<string, unknown>> => request("/v1/ui/apply/eligibility", { method: "POST", body: JSON.stringify(body) });
export const createApplyPlan = (body: Record<string, unknown>): Promise<Record<string, unknown>> => request("/v1/ui/apply-plans", { method: "POST", body: JSON.stringify(body) });
export const mutateApply = (applyId: string, action: "prepare" | "promote" | "cancel", body: Record<string, unknown>): Promise<Record<string, unknown>> => request(`/v1/ui/apply/${encodeURIComponent(applyId)}/${action}`, { method: "POST", body: JSON.stringify(body) });
export const mutateRouting = (taskId: string, action: "generate" | "confirm" | "reject", body: Record<string, unknown>, recommendationId?: string): Promise<Record<string, unknown>> => {
  const base = `/v1/ui/tasks/${encodeURIComponent(taskId)}/routing/recommendations`;
  const path = action === "generate" ? base : `${base}/${encodeURIComponent(recommendationId ?? "invalid")}/${action}`;
  return request(path, { method: "POST", body: JSON.stringify(body) });
};
export const confirmRoutingFallback = (taskId: string, fallbackId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => request(`/v1/ui/tasks/${encodeURIComponent(taskId)}/routing/fallback/${encodeURIComponent(fallbackId)}/confirm`, { method: "POST", body: JSON.stringify(body) });
