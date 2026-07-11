import { describe, expect, it } from "vitest";
import {
  EventSequenceSchema,
  SequenceNumberSchema,
  StreamCursorSchema,
  StreamStateSchema,
  advanceCursor,
  classifyIncomingEvent,
  classifyResume,
  compareCursors,
  type StreamCursor,
  type StreamEventDescriptor,
  type StreamState,
} from "../../src/index.js";

const cursor = (lastConsumedSequence: number, streamId = "stream-task-42"): StreamCursor => ({
  streamId,
  lastConsumedSequence,
});

const stream = (
  headSequence: number,
  oldestRetainedSequence = 1,
  streamId = "stream-task-42",
): StreamState => ({ streamId, headSequence, oldestRetainedSequence });

const event = (sequence: number, streamId = "stream-task-42"): StreamEventDescriptor => ({
  streamId,
  sequence,
  eventId: `evt-${sequence}`,
});

describe("cursor model: last successfully consumed event", () => {
  it("a brand-new consumer (cursor 0) resumes at sequence 1", () => {
    expect(classifyResume(cursor(0), stream(5))).toEqual({ kind: "valid", nextSequence: 1 });
  });

  it("resume delivers exactly lastConsumed + 1", () => {
    expect(classifyResume(cursor(3), stream(10))).toEqual({ kind: "valid", nextSequence: 4 });
  });

  it("cursor equal to head is valid with nothing pending (next = head + 1)", () => {
    expect(classifyResume(cursor(5), stream(5))).toEqual({ kind: "valid", nextSequence: 6 });
  });

  it("cursor 0 against an empty stream is valid", () => {
    expect(classifyResume(cursor(0), stream(0))).toEqual({ kind: "valid", nextSequence: 1 });
  });
});

describe("resume error conditions", () => {
  it("cursor ahead of the stream head", () => {
    expect(classifyResume(cursor(6), stream(5))).toEqual({ kind: "cursor-ahead", headSequence: 5 });
    expect(classifyResume(cursor(1), stream(0))).toEqual({ kind: "cursor-ahead", headSequence: 0 });
  });

  it("cursor too old: the next needed event was pruned", () => {
    // Need event 3; oldest retained is 5 → pruned.
    expect(classifyResume(cursor(2), stream(10, 5))).toEqual({
      kind: "cursor-too-old",
      oldestRetainedSequence: 5,
    });
  });

  it("off-by-one boundary: next needed event exactly equals oldest retained", () => {
    // Need event 5; oldest retained is 5 → exactly resumable.
    expect(classifyResume(cursor(4), stream(10, 5))).toEqual({ kind: "valid", nextSequence: 5 });
    // Need event 4; oldest retained is 5 → one too old.
    expect(classifyResume(cursor(3), stream(10, 5))).toEqual({
      kind: "cursor-too-old",
      oldestRetainedSequence: 5,
    });
  });

  it("unknown stream", () => {
    expect(classifyResume(cursor(3, "stream-a"), stream(10, 1, "stream-b"))).toEqual({
      kind: "unknown-stream",
    });
  });
});

describe("incoming event classification", () => {
  it("sequential next event", () => {
    expect(classifyIncomingEvent(cursor(3), event(4))).toBe("next");
  });

  it("duplicate: anything at or below the cursor", () => {
    expect(classifyIncomingEvent(cursor(3), event(3))).toBe("duplicate");
    expect(classifyIncomingEvent(cursor(3), event(1))).toBe("duplicate");
  });

  it("sequence gap: anything beyond lastConsumed + 1", () => {
    expect(classifyIncomingEvent(cursor(3), event(5))).toBe("sequence-gap");
    expect(classifyIncomingEvent(cursor(0), event(2))).toBe("sequence-gap");
  });

  it("initial stream: first event is next for a fresh cursor", () => {
    expect(classifyIncomingEvent(cursor(0), event(1))).toBe("next");
  });

  it("wrong stream", () => {
    expect(classifyIncomingEvent(cursor(3, "stream-a"), event(4, "stream-b"))).toBe(
      "unknown-stream",
    );
  });
});

describe("advanceCursor", () => {
  it("advances by exactly the next event", () => {
    const result = advanceCursor(cursor(3), event(4));
    expect(result).toEqual({ ok: true, cursor: cursor(4) });
  });

  it("consuming a whole ordered stream advances one by one", () => {
    let current = cursor(0);
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      const result = advanceCursor(current, event(sequence));
      if (!result.ok) throw new Error("expected advance");
      current = result.cursor;
    }
    expect(current.lastConsumedSequence).toBe(5);
  });

  it("refuses duplicates and gaps without advancing", () => {
    expect(advanceCursor(cursor(3), event(3))).toEqual({ ok: false, classification: "duplicate" });
    expect(advanceCursor(cursor(3), event(6))).toEqual({
      ok: false,
      classification: "sequence-gap",
    });
    expect(advanceCursor(cursor(3, "stream-a"), event(4, "stream-b"))).toEqual({
      ok: false,
      classification: "unknown-stream",
    });
  });
});

describe("cursor comparison", () => {
  it("is deterministic within one stream", () => {
    expect(compareCursors(cursor(1), cursor(2))).toBe(-1);
    expect(compareCursors(cursor(2), cursor(1))).toBe(1);
    expect(compareCursors(cursor(2), cursor(2))).toBe(0);
  });

  it("cursors from different streams are not comparable", () => {
    expect(() => compareCursors(cursor(1, "stream-a"), cursor(1, "stream-b"))).toThrow(TypeError);
  });
});

describe("schema bounds", () => {
  it("sequences are non-negative safe integers; events are numbered from 1", () => {
    expect(SequenceNumberSchema.safeParse(0).success).toBe(true);
    expect(SequenceNumberSchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
    expect(SequenceNumberSchema.safeParse(-1).success).toBe(false);
    expect(SequenceNumberSchema.safeParse(1.5).success).toBe(false);
    expect(SequenceNumberSchema.safeParse(Number.MAX_SAFE_INTEGER + 2).success).toBe(false);
    expect(EventSequenceSchema.safeParse(0).success).toBe(false);
    expect(EventSequenceSchema.safeParse(1).success).toBe(true);
  });

  it("cursors and stream states are strict", () => {
    expect(StreamCursorSchema.safeParse({ ...cursor(1), extra: true }).success).toBe(false);
    expect(
      StreamStateSchema.safeParse({ ...stream(5), secretPath: "C:/x" }).success,
    ).toBe(false);
  });

  it("a stream cannot claim retention older than head + 1", () => {
    expect(StreamStateSchema.safeParse(stream(5, 7)).success).toBe(false);
    expect(StreamStateSchema.safeParse(stream(5, 6)).success).toBe(true); // fully pruned
    expect(StreamStateSchema.safeParse(stream(0, 1)).success).toBe(true); // empty stream
  });
});
