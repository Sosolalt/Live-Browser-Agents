import { describe, expect, it } from "vitest";
import { decodePcm16Base64ToFloat32 } from "../src/shared/audioCodec";

describe("audio codec", () => {
  it("decodes little-endian pcm16 base64", () => {
    const bytes = new Uint8Array([0x00, 0x80, 0x00, 0x00, 0xff, 0x7f]); // -32768, 0, 32767
    const pcmBase64 =
      typeof Buffer !== "undefined"
        ? Buffer.from(bytes).toString("base64")
        : btoa(String.fromCharCode(...bytes));
    const decoded = decodePcm16Base64ToFloat32(pcmBase64);
    expect(decoded.length).toBe(3);
    expect(decoded[0]).toBeCloseTo(-1, 5);
    expect(decoded[1]).toBeCloseTo(0, 5);
    expect(decoded[2]).toBeGreaterThan(0.99);
  });
});
