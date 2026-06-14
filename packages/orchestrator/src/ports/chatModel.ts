import type { z } from "zod";

/**
 * Multi-model routing: heavy reasoning runs on the "pro" tier, cheap
 * classification on "flash". Each node picks a tier; the router resolves it
 * to a concrete model. A real adapter wraps @langchain/google-genai chat models.
 */
export type ModelTier = "pro" | "flash";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatModel {
  readonly tier: ModelTier;
  complete(messages: ChatMessage[]): Promise<string>;
}

export interface ChatModelRouter {
  forTier(tier: ModelTier): ChatModel;
}

/**
 * Deterministic, offline ChatModel used as the default and in tests. Agents tag
 * structured requests with a `DIRECTIVE: <kind>` line in the system message and
 * pass their inputs as JSON in the final user message; this model returns a
 * stable, schema-shaped JSON response computed from those inputs. A production
 * Gemini adapter ignores the directive and actually reasons over the prompt.
 */
export class DeterministicChatModel implements ChatModel {
  readonly tier: ModelTier;

  constructor(tier: ModelTier = "pro") {
    this.tier = tier;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const system = messages.find((message) => message.role === "system")?.content ?? "";
    const directive = /DIRECTIVE:\s*([a-z_]+)/.exec(system)?.[1];
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const input = parseJson(lastUser?.content ?? "{}");
    return JSON.stringify(this.respond(directive, input));
  }

  private respond(directive: string | undefined, input: Record<string, unknown>): unknown {
    switch (directive) {
      case "semantic_tags":
        return semanticTags(input);
      case "research":
        return research(input);
      case "entity_extract":
        return entityExtract(input);
      default:
        return { ok: true, echo: input };
    }
  }
}

/** Same model for both tiers — fine for the deterministic default. */
export class StaticChatModelRouter implements ChatModelRouter {
  private readonly pro: ChatModel;
  private readonly flash: ChatModel;

  constructor(pro?: ChatModel, flash?: ChatModel) {
    this.pro = pro ?? new DeterministicChatModel("pro");
    this.flash = flash ?? new DeterministicChatModel("flash");
  }

  forTier(tier: ModelTier): ChatModel {
    return tier === "pro" ? this.pro : this.flash;
  }
}

/** Test helper: returns queued responses in order, then repeats the last one. */
export class ScriptedChatModel implements ChatModel {
  readonly tier: ModelTier;
  private index = 0;

  constructor(
    private readonly responses: string[],
    tier: ModelTier = "pro"
  ) {
    this.tier = tier;
  }

  async complete(): Promise<string> {
    const response = this.responses[Math.min(this.index, this.responses.length - 1)] ?? "{}";
    this.index += 1;
    return response;
  }
}

export class StructuredParseError extends Error {
  constructor(
    message: string,
    readonly raw: string
  ) {
    super(message);
    this.name = "StructuredParseError";
  }
}

/**
 * LangChain-style structured generation with output parsing and reflective
 * retry: on malformed/invalid output the failure is fed back to the model and
 * it is asked to correct itself, up to `maxRetries` times.
 */
export const generateStructured = async <T>(
  model: ChatModel,
  messages: ChatMessage[],
  schema: z.ZodType<T>,
  options: { maxRetries?: number } = {}
): Promise<T> => {
  const maxRetries = options.maxRetries ?? 2;
  const conversation = [...messages];
  let lastError = "";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const raw = await model.complete(conversation);
    const json = extractJson(raw);
    if (json !== undefined) {
      const parsed = schema.safeParse(json);
      if (parsed.success) {
        return parsed.data;
      }
      lastError = parsed.error.message;
    } else {
      lastError = "Response did not contain a JSON object.";
    }

    if (attempt < maxRetries) {
      conversation.push({ role: "assistant", content: raw });
      conversation.push({
        role: "user",
        content: `Your previous response was invalid: ${lastError}. Respond again with ONLY valid JSON matching the schema.`
      });
    }
  }

  throw new StructuredParseError(`Structured output failed after ${maxRetries + 1} attempts: ${lastError}`, lastError);
};

const parseJson = (text: string): Record<string, unknown> => {
  const value = extractJson(text);
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
};

/** Tolerant JSON extraction: accepts raw JSON or a fenced/embedded object. */
export const extractJson = (text: string): unknown => {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to brace extraction
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const semanticTags = (input: Record<string, unknown>): unknown => {
  const elements = Array.isArray(input.elements) ? input.elements : [];
  return {
    tags: elements.slice(0, 20).map((element, index) => {
      const record = (element ?? {}) as Record<string, unknown>;
      return {
        selector: typeof record.selector === "string" ? record.selector : `#el-${index}`,
        role: typeof record.role === "string" ? record.role : "generic",
        label: typeof record.label === "string" ? record.label : `element ${index}`
      };
    })
  };
};

const research = (input: Record<string, unknown>): unknown => {
  const query = typeof input.query === "string" ? input.query : "";
  const facts = Array.isArray(input.facts) ? input.facts : [];
  const summary =
    facts.length > 0
      ? `Grounded answer for "${query}" from ${facts.length} prior fact(s).`
      : `No prior knowledge for "${query}"; answer from the live page only.`;
  return { summary };
};

const entityExtract = (input: Record<string, unknown>): unknown => {
  const text = typeof input.text === "string" ? input.text : "";
  const entities: Array<{ name: string; type: string }> = [];
  const orderMatch = /\border\s*#?\s*([a-z0-9-]{4,})/i.exec(text);
  if (orderMatch) {
    entities.push({ name: orderMatch[1], type: "Order" });
  }
  const emailMatch = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.exec(text);
  if (emailMatch) {
    entities.push({ name: emailMatch[0], type: "Account" });
  }
  return { entities };
};
