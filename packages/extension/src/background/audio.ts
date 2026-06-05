const TARGET_SAMPLE_RATE = 16_000;

const clampUnit = (value: number): number => {
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
};

const encodeBase64 = (bytes: Uint8Array): string => {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
};

export const resampleLinear = (sourceSamples: Float32Array, sourceRate: number, targetRate: number): Float32Array => {
  if (sourceRate <= 0 || targetRate <= 0 || sourceSamples.length === 0) {
    return new Float32Array();
  }
  if (sourceRate === targetRate) {
    return sourceSamples;
  }

  const ratio = sourceRate / targetRate;
  const outputLength = Math.max(1, Math.round(sourceSamples.length / ratio));
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const lower = Math.floor(sourceIndex);
    const upper = Math.min(sourceSamples.length - 1, lower + 1);
    const weight = sourceIndex - lower;
    output[index] = sourceSamples[lower] * (1 - weight) + sourceSamples[upper] * weight;
  }

  return output;
};

export const float32ToPcm16 = (samples: Float32Array): Int16Array => {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = clampUnit(samples[index]);
    pcm[index] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return pcm;
};

export const encodePcm16Base64 = (pcmSamples: Int16Array): string => {
  const bytes = new Uint8Array(pcmSamples.buffer, pcmSamples.byteOffset, pcmSamples.byteLength);
  return encodeBase64(bytes);
};

export const normalizeMicChunkForTransport = (
  samples: number[],
  sourceSampleRate: number
): { mimeType: string; sampleRate: number; pcmBase64: string } => {
  const source = Float32Array.from(samples);
  const resampled = resampleLinear(source, sourceSampleRate, TARGET_SAMPLE_RATE);
  const pcm = float32ToPcm16(resampled);
  return {
    mimeType: "audio/pcm;rate=16000",
    sampleRate: TARGET_SAMPLE_RATE,
    pcmBase64: encodePcm16Base64(pcm)
  };
};
