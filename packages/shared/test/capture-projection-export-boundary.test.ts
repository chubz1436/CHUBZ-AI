import { describe, expect, it } from "vitest";
import * as shared from "../src/index.js";

describe("M1E capture/projection public export boundary", () => {
  it("exports only pure claim, shape-parser, evaluation, hashing, and serialization entry points", () => {
    expect(shared.CAPTURE_PROJECTION_VERSION).toBe("1.0");
    expect(typeof shared.parseCaptureRecord).toBe("function");
    expect(typeof shared.parseArtifactMetadata).toBe("function");
    expect(typeof shared.parseAuthoritativeM1ESnapshotShape).toBe("function");
    expect(typeof shared.evaluateCaptureTrust).toBe("function");
    expect(typeof shared.evaluateArtifactTrust).toBe("function");
    expect(typeof shared.evaluateReviewPackageManifestTrust).toBe("function");
    expect(typeof shared.digestReviewPackageManifest).toBe("function");
    expect(typeof shared.serializeBridgeLogFrontMatter).toBe("function");
    for (const forbidden of ["capture", "readArtifact", "writeArtifact", "createArchive", "createZip", "disableRedaction", "detectorRegistry", "parseTrustedM1EContext", "loadAuthoritativeSnapshot", "persistSnapshot", "resolveEvidence", "openBridgeLog"]) {
      expect(forbidden in shared).toBe(false);
    }
  });
});
