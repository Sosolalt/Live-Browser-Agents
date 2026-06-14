import crypto from "node:crypto";

/**
 * Embedding port. Real adapters (Gemini text-embedding, etc.) implement the
 * same interface; the orchestrator and memory subsystem never depend on a
 * concrete model.
 */
export interface Embedder {
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

/**
 * Deterministic, dependency-free embedder used for tests and local dev. It hashes
 * token n-grams into a fixed-width bag-of-features vector and L2-normalises, so
 * cosine similarity is meaningful and stable across runs (no network, no key).
 */
export class HashEmbedder implements Embedder {
  readonly dimensions: number;

  constructor(dimensions = 64) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    return this.embedSync(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedSync(text));
  }

  private embedSync(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = tokenize(text);
    for (const token of tokens) {
      const digest = crypto.createHash("sha256").update(token).digest();
      const index = digest.readUInt32BE(0) % this.dimensions;
      // Signed contribution keeps vectors centred instead of all-positive.
      const sign = (digest[4] & 1) === 0 ? 1 : -1;
      vector[index] += sign;
    }
    return l2normalize(vector);
  }
}

const tokenize = (text: string): string[] => {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const grams: string[] = [...words];
  for (let i = 0; i < words.length - 1; i += 1) {
    grams.push(`${words[i]}_${words[i + 1]}`);
  }
  return grams;
};

const l2normalize = (vector: number[]): number[] => {
  let sumSquares = 0;
  for (const value of vector) {
    sumSquares += value * value;
  }
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) {
    return vector;
  }
  return vector.map((value) => value / norm);
};

export const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};
