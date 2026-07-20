import { describe, expect, it } from "vitest";
import * as shared from "../src/index.js";

describe("M1E capture/projection public export boundary", () => {
  it("exports only pure schemas, parsers, hashing and safe serialization entry points", () => {
    expect(shared.CAPTURE_PROJECTION_VERSION).toBe("1.0");
    expect(typeof shared.parseCaptureRecord).toBe("function");
    expect(typeof shared.parseArtifactMetadata).toBe("function");
    expect(typeof shared.digestReviewPackageManifest).toBe("function");
    expect(typeof shared.serializeBridgeLogFrontMatter).toBe("function");
    for (const forbidden of ["capture", "readArtifact", "writeArtifact", "createArchive", "createZip", "disableRedaction", "detectorRegistry"]) {
      expect(forbidden in shared).toBe(false);
    }
  });
});
