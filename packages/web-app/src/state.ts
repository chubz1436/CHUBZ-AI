import type { Task } from "./types.js";

export const boardColumns = [
  { id: "pending", title: "Pending", description: "Draft or preparing" },
  { id: "approval", title: "Owner approval", description: "A decision is required" },
  { id: "queued", title: "Eligible / queued", description: "Server-approved queue" },
  { id: "dispatched", title: "Assigned", description: "Claimed for dispatch" },
  { id: "running", title: "Running", description: "Execution in progress" },
  { id: "cancelled", title: "Cancelled", description: "Stopped or rejected" },
  { id: "attention", title: "Needs attention", description: "Failed or blocked" },
  { id: "completed", title: "Completed", description: "Authoritatively finished" },
] as const;

export type BoardColumn = (typeof boardColumns)[number]["id"];

export function taskColumn(task: Task): BoardColumn {
  if (["DRAFT", "CONTEXT_PREPARING"].includes(task.state)) return "pending";
  if (["RESULT_CAPTURED", "AWAITING_APPROVAL", "APPROVED", "REVISION_REQUESTED"].includes(task.state)) return "approval";
  if (task.state === "AWAITING_DISPATCH") {
    const assignment = task.assignments.at(-1);
    if (assignment?.["status"] === "pending-approval") return "approval";
    if (task.queue?.["status"] === "claimed") return "dispatched";
    return "queued";
  }
  if (["RUNNING", "CANCELLING"].includes(task.state)) return "running";
  if (["CANCELLED", "REJECTED"].includes(task.state)) return "cancelled";
  if (["FAILED", "BLOCKED"].includes(task.state)) return "attention";
  return "completed";
}

export function statusLabel(task: Task): string {
  if (task.executionUnknown) return "Execution unknown";
  return task.state.toLowerCase().replaceAll("_", " ");
}

export function mergeTasks(current: Task[], incoming: Task[]): Task[] {
  const merged = new Map(current.map((task) => [task.taskId, task]));
  for (const task of incoming) {
    const existing = merged.get(task.taskId);
    if (!existing || task.version > existing.version || (task.version === existing.version && Date.parse(task.updatedAt) >= Date.parse(existing.updatedAt))) merged.set(task.taskId, task);
  }
  return [...merged.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export type IncomingSequence = "duplicate" | "next" | "gap" | "invalid";

export function classifyIncomingSequence(lastConsumedSequence: number, incomingSequence: number): IncomingSequence {
  if (!Number.isSafeInteger(incomingSequence) || incomingSequence < 1) return "invalid";
  if (incomingSequence <= lastConsumedSequence) return "duplicate";
  if (incomingSequence === lastConsumedSequence + 1) return "next";
  return "gap";
}

export const newIdempotencyKey = (prefix: string): string => `${prefix}:${crypto.randomUUID()}`;
