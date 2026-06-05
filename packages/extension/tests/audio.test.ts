import { describe, expect, it } from "vitest";
import { float32ToPcm16, normalizeMicChunkForTransport, resampleLinear } from "../src/background/audio";

describe("audio processing", () => {
  it("resamples input to target rate", () => {
    const source = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
    const output = resampleLinear(source, 48_000, 16_000);
    expect(output.length).toBeGreaterThan(0);
    expect(output.length).toBeLessThan(source.length);
  });

  it("converts float samples to pcm16", () => {
    const pcm = float32ToPcm16(new Float32Array([-1, 0, 1]));
    expect(Array.from(pcm)).toEqual([-32768, 0, 32767]);
  });

  it("normalizes mic chunk to base64 pcm payload", () => {
    const payload = normalizeMicChunkForTransport([0, 0.1, -0.1, 0.2], 44_100);
    expect(payload.mimeType).toBe("audio/pcm;rate=16000");
    expect(payload.sampleRate).toBe(16_000);
    expect(typeof payload.pcmBase64).toBe("string");
    expect(payload.pcmBase64.length).toBeGreaterThan(0);
  });
});
