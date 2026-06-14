import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Resolve the orchestrator workspace from its TypeScript source so backend
// tests run without a prior `tsc` build of the orchestrator package.
export default defineConfig({
  resolve: {
    alias: {
      "@gemini-hackaton/orchestrator": resolve(__dirname, "../orchestrator/src/index.ts")
    }
  },
  test: {
    // Run test files serially: the timing-sensitive rate-limit/auth tests make
    // sequential HTTP round-trips and must not contend for CPU with the
    // CPU-bound LangGraph orchestration tests (avoids per-test timeout flakes).
    fileParallelism: false,
    testTimeout: 20_000
  }
});
