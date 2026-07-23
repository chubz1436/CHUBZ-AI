export type TaskState = "DRAFT" | "CONTEXT_PREPARING" | "AWAITING_DISPATCH" | "RUNNING" | "RESULT_CAPTURED" | "AWAITING_APPROVAL" | "APPROVED" | "REVISION_REQUESTED" | "REJECTED" | "BLOCKED" | "CANCELLING" | "CANCELLED" | "FAILED" | "COMPLETED";

export type Task = {
  taskId: string; projectId: string; state: TaskState; version: number; attemptId: string | null; operationId: string | null;
  createdAt: string | null; updatedAt: string; cancellationRequestedAt: string | null; blockedContext: Record<string, unknown> | null; executionUnknown: boolean;
  attempts: Array<{ attemptId: string; sequence: number; actionDigest: string; instructions: string; createdAt: string; operation: string | null; operationId: string | null; workerId: string | null; timeoutSec: number | null; requiresCleanWorktree: boolean | null }>;
  assignments: Array<Record<string, unknown>>; approval: Record<string, unknown> | null; grant: Record<string, unknown> | null; lease: Record<string, unknown> | null;
  scopes: Array<Record<string, unknown>>; queue: Record<string, unknown> | null; results: Array<Record<string, unknown>>; manualResults: Array<Record<string, unknown>>;
  structuredResult: Record<string, unknown> | null; transitions: Array<Record<string, unknown>>; events: Array<Record<string, unknown>>; captures: Array<Record<string, unknown>>;
  actions: { canApproveDispatch: boolean; canCancel: boolean; canDecideResult: boolean; canSubmitManualText: boolean; canRequestCapture: boolean; canRetry: false };
};

export type Adapter = {
  readinessId: string; workerId: string; adapterId: string; connectorTier: string; providerId: string; runtimeId: string; version: string;
  executableId: string | null; executableHash: string | null; authenticationState: string; readinessState: string; healthStatus: string; freezeState: string;
  sandboxCapability: string; sandboxAssurance: string; noninteractiveCapability: string; structuredOutputCapability: string; cancellationCapability: string; resumeCapability: string;
  quotaConfidence: string; capabilityProbeAt: string | null; recordedAt: string; degradedBoundedLocal: boolean; drift: boolean;
};

export type Snapshot = {
  generatedAt: string; csrfToken: string; session: { username: string; role: string }; controlPlane: { health: string; readiness: string; localOnly: boolean };
  bridge: { availability: string; connected: boolean; lastSeenAt: string | null; reason: string };
  cursor: { streamId: string; lastConsumedSequence: number; oldestRetainedSequence: number };
  tasks: Task[]; adapters: Adapter[]; workers: Array<Record<string, unknown>>; applies: Array<Record<string, unknown>>; applyIncidents: Array<Record<string, unknown>>;
  operations: {
    projection: { schemaVersion: string; cursor: number; entryCount: number; status: string; verifiedAt: string | null; rebuiltAt: string | null; failureReason: string | null; version: number; authoritative: false; editable: false };
    bridge: { availability: string; connected: boolean; lastSeenAt: string | null; failClosed: boolean };
    emergency: { active: boolean; scopeVersions: Record<string, number>; stops: Array<Record<string, unknown>> };
    incidents: Array<Record<string, unknown>>; entries: Array<Record<string, unknown>>; reconciliation: Record<string, unknown> | null;
  };
  manualRelay: { available: boolean; provenance: string; assurance: string; automatedExecution: false; artifactTransportAvailable: boolean; allowedArtifactTypes: string[]; appliedToProject: false; appliedToWorktree: false };
};

export type ApiError = Error & { status?: number; code?: string };
export type ConnectionState = "connecting" | "live" | "disconnected" | "resynchronizing";
export type Page = "chat" | "board" | "adapters" | "operations";
