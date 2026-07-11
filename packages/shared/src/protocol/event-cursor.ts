import { z } from "zod";
import { SafeIdSchema } from "./common.js";

/**
 * Event cursor and stream-resume contracts (M1B, D-023).
 *
 * CURSOR MODEL (chosen and fixed): a cursor records the sequence of the
 * LAST SUCCESSFULLY CONSUMED event. Resume therefore delivers events
 * starting at `lastConsumedSequence + 1`. A brand-new consumer uses
 * cursor 0. Sequences are 1-based positive safe integers assigned in
 * order within one stream; `headSequence` 0 means an empty stream.
 *
 * Pure helpers only — no event persistence, no WebSockets.
 */

/** 0 is legal for cursors (nothing consumed yet) and empty-stream heads. */
export const SequenceNumberSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
export type SequenceNumber = z.infer<typeof SequenceNumberSchema>;

/** Events themselves are numbered from 1. */
export const EventSequenceSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);
export type EventSequence = z.infer<typeof EventSequenceSchema>;

export const StreamCursorSchema = z.strictObject({
  streamId: SafeIdSchema,
  /** Sequence of the last successfully consumed event; 0 = none yet. */
  lastConsumedSequence: SequenceNumberSchema,
});
export type StreamCursor = z.infer<typeof StreamCursorSchema>;

/** Identity of one event within a stream. */
export const StreamEventDescriptorSchema = z.strictObject({
  streamId: SafeIdSchema,
  sequence: EventSequenceSchema,
  eventId: SafeIdSchema,
});
export type StreamEventDescriptor = z.infer<typeof StreamEventDescriptorSchema>;

/** What the future runtime knows about a stream when resuming. */
export const StreamStateSchema = z
  .strictObject({
    streamId: SafeIdSchema,
    /** Highest assigned sequence; 0 for an empty stream. */
    headSequence: SequenceNumberSchema,
    /** Lowest still-retained sequence (older events were pruned). */
    oldestRetainedSequence: EventSequenceSchema,
  })
  .refine(
    (stream) => stream.oldestRetainedSequence <= stream.headSequence + 1,
    "oldestRetainedSequence may be at most headSequence + 1 (fully pruned/empty stream)",
  );
export type StreamState = z.infer<typeof StreamStateSchema>;

export const RESUME_RESULT_KINDS = Object.freeze([
  "valid",
  "cursor-ahead",
  "cursor-too-old",
  "unknown-stream",
] as const);
export type ResumeResultKind = (typeof RESUME_RESULT_KINDS)[number];

export const ResumeResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("valid"),
    /** First sequence to deliver: lastConsumedSequence + 1. */
    nextSequence: EventSequenceSchema,
  }),
  z.strictObject({ kind: z.literal("cursor-ahead"), headSequence: SequenceNumberSchema }),
  z.strictObject({ kind: z.literal("cursor-too-old"), oldestRetainedSequence: EventSequenceSchema }),
  z.strictObject({ kind: z.literal("unknown-stream") }),
]);
export type ResumeResult = z.infer<typeof ResumeResultSchema>;

/**
 * Deterministic resume classification.
 *
 * Off-by-one contract (tested exhaustively):
 *  - cursor N against head N            → valid, nextSequence N+1 (nothing pending)
 *  - cursor N against head > N          → valid, nextSequence N+1
 *  - cursor N with N+1 < oldestRetained → cursor-too-old (event N+1 pruned)
 *  - cursor N with N+1 = oldestRetained → valid (exactly resumable)
 *  - cursor N > head                    → cursor-ahead
 */
export function classifyResume(cursor: StreamCursor, stream: StreamState): ResumeResult {
  const parsedCursor = StreamCursorSchema.parse(cursor);
  const parsedStream = StreamStateSchema.parse(stream);

  if (parsedCursor.streamId !== parsedStream.streamId) {
    return { kind: "unknown-stream" };
  }
  if (parsedCursor.lastConsumedSequence > parsedStream.headSequence) {
    return { kind: "cursor-ahead", headSequence: parsedStream.headSequence };
  }
  if (parsedCursor.lastConsumedSequence + 1 < parsedStream.oldestRetainedSequence) {
    return { kind: "cursor-too-old", oldestRetainedSequence: parsedStream.oldestRetainedSequence };
  }
  return { kind: "valid", nextSequence: parsedCursor.lastConsumedSequence + 1 };
}

export const EVENT_CLASSIFICATIONS = Object.freeze([
  "next",
  "duplicate",
  "sequence-gap",
  "unknown-stream",
] as const);
export type EventClassification = (typeof EVENT_CLASSIFICATIONS)[number];

/**
 * Classifies one incoming event against a consumer's cursor:
 * sequence == lastConsumed + 1 → "next"; <= lastConsumed → "duplicate"
 * (already consumed — safe to drop); > lastConsumed + 1 →
 * "sequence-gap" (events were missed; resume required).
 */
export function classifyIncomingEvent(
  cursor: StreamCursor,
  event: StreamEventDescriptor,
): EventClassification {
  const parsedCursor = StreamCursorSchema.parse(cursor);
  const parsedEvent = StreamEventDescriptorSchema.parse(event);
  if (parsedCursor.streamId !== parsedEvent.streamId) {
    return "unknown-stream";
  }
  if (parsedEvent.sequence <= parsedCursor.lastConsumedSequence) {
    return "duplicate";
  }
  if (parsedEvent.sequence === parsedCursor.lastConsumedSequence + 1) {
    return "next";
  }
  return "sequence-gap";
}

/** Deterministic cursor comparison within ONE stream; mixed streams throw. */
export function compareCursors(a: StreamCursor, b: StreamCursor): -1 | 0 | 1 {
  const parsedA = StreamCursorSchema.parse(a);
  const parsedB = StreamCursorSchema.parse(b);
  if (parsedA.streamId !== parsedB.streamId) {
    throw new TypeError("compareCursors: cursors from different streams are not comparable");
  }
  if (parsedA.lastConsumedSequence < parsedB.lastConsumedSequence) return -1;
  if (parsedA.lastConsumedSequence > parsedB.lastConsumedSequence) return 1;
  return 0;
}

export type AdvanceResult =
  | { readonly ok: true; readonly cursor: StreamCursor }
  | { readonly ok: false; readonly classification: Exclude<EventClassification, "next"> };

/** Advances a cursor by exactly the next event; anything else is refused. */
export function advanceCursor(cursor: StreamCursor, event: StreamEventDescriptor): AdvanceResult {
  const classification = classifyIncomingEvent(cursor, event);
  if (classification !== "next") {
    return { ok: false, classification };
  }
  return {
    ok: true,
    cursor: Object.freeze({ streamId: cursor.streamId, lastConsumedSequence: event.sequence }),
  };
}
