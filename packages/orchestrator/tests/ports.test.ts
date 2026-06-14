import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cosineSimilarity, HashEmbedder } from "../src/ports/embedder.js";
import { generateStructured, ScriptedChatModel, StructuredParseError } from "../src/ports/chatModel.js";

describe("HashEmbedder", () => {
  it("is deterministic and ranks similar text higher", async () => {
    const embedder = new HashEmbedder();
    const a = await embedder.embed("running shoes for marathon");
    const aAgain = await embedder.embed("running shoes for marathon");
    const near = await embedder.embed("running shoes for a marathon race");
    const far = await embedder.embed("quarterly tax accounting spreadsheet");
    expect(a).toEqual(aAgain);
    expect(cosineSimilarity(a, near)).toBeGreaterThan(cosineSimilarity(a, far));
  });
});

describe("generateStructured", () => {
  it("reflects and retries on malformed output, then parses", async () => {
    const schema = z.object({ ok: z.boolean(), count: z.number() });
    const model = new ScriptedChatModel(["not json at all", '{"ok": true}', '{"ok": true, "count": 3}']);
    const result = await generateStructured(model, [{ role: "user", content: "go" }], schema, { maxRetries: 3 });
    expect(result).toEqual({ ok: true, count: 3 });
  });

  it("throws StructuredParseError after exhausting retries", async () => {
    const schema = z.object({ ok: z.boolean() });
    const model = new ScriptedChatModel(["nope", "still nope"]);
    await expect(generateStructured(model, [{ role: "user", content: "go" }], schema, { maxRetries: 1 })).rejects.toBeInstanceOf(
      StructuredParseError
    );
  });
});
