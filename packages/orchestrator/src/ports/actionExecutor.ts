import type { ActionResult, AgentAction, DomSnapshot } from "../types.js";

/**
 * Bridge between the graph's decisions and the world that executes them. In
 * production the backend dispatches AgentActions to the extension content
 * script (which performs click/fill/navigate on the real DOM) and returns
 * ActionResults. Tests use the SimulatedActionExecutor below.
 */
export interface ActionExecutor {
  /** Current page snapshot, consumed by the Perception agent. */
  snapshot(): Promise<DomSnapshot>;
  execute(action: AgentAction): Promise<ActionResult>;
}

export interface SimulatedPage {
  url: string;
  title: string;
  fields: Record<string, string>;
  submitted: boolean;
}

export type ForcedOutcome = Partial<Pick<ActionResult, "ok" | "observation" | "error">> & {
  /** Override the post-state the verifier sees (e.g. simulate a divergence). */
  postState?: Record<string, unknown>;
};

export interface SimulatedActionExecutorOptions {
  url?: string;
  title?: string;
  elements?: DomSnapshot["elements"];
  text?: string;
  /** Keyed by `${kind}:${target}` to force a deterministic outcome for tests. */
  forced?: Record<string, ForcedOutcome>;
}

/**
 * Deterministic in-memory page model. Tracks navigation, form fills and
 * submission so the Verifier's post-state checks and rollback are exercisable
 * without a browser.
 */
export class SimulatedActionExecutor implements ActionExecutor {
  private readonly page: SimulatedPage;
  private readonly elements: DomSnapshot["elements"];
  private readonly text: string;
  private readonly forced: Record<string, ForcedOutcome>;

  constructor(options: SimulatedActionExecutorOptions = {}) {
    this.page = {
      url: options.url ?? "https://example.test/",
      title: options.title ?? "Example",
      fields: {},
      submitted: false
    };
    this.elements = options.elements ?? defaultElements;
    this.text = options.text ?? "Example page body text.";
    this.forced = options.forced ?? {};
  }

  async snapshot(): Promise<DomSnapshot> {
    return {
      url: this.page.url,
      title: this.page.title,
      elements: this.elements,
      text: this.text
    };
  }

  async execute(action: AgentAction): Promise<ActionResult> {
    const forced = this.forced[`${action.kind}:${action.target ?? ""}`];
    const base = this.apply(action);
    if (!forced) {
      return base;
    }
    return {
      ...base,
      ok: forced.ok ?? base.ok,
      observation: forced.observation ?? base.observation,
      error: forced.error ?? base.error,
      postState: forced.postState ?? base.postState
    };
  }

  private apply(action: AgentAction): ActionResult {
    switch (action.kind) {
      case "navigate": {
        const previous = this.page.url;
        this.page.url = action.target ?? this.page.url;
        return {
          actionId: action.id,
          ok: true,
          observation: `Navigated to ${this.page.url}`,
          postState: { url: this.page.url },
          reversible: true,
          undo: { id: `${action.id}-undo`, kind: "navigate", target: previous, blastRadius: "low" }
        };
      }
      case "fill": {
        const selector = action.target ?? "";
        const previous = this.page.fields[selector] ?? "";
        this.page.fields[selector] = action.value ?? "";
        return {
          actionId: action.id,
          ok: true,
          observation: `Filled ${selector}`,
          postState: { fields: { ...this.page.fields } },
          reversible: true,
          undo: { id: `${action.id}-undo`, kind: "fill", target: selector, value: previous, blastRadius: "low" }
        };
      }
      case "click":
      case "scroll":
      case "wait":
      case "noop": {
        return {
          actionId: action.id,
          ok: true,
          observation: `${action.kind} ${action.target ?? ""}`.trim(),
          postState: { url: this.page.url, fields: { ...this.page.fields } },
          reversible: true,
          undo: null
        };
      }
      case "submit": {
        this.page.submitted = true;
        return {
          actionId: action.id,
          ok: true,
          observation: `Submitted ${action.target ?? "form"}`,
          postState: { submitted: true, fields: { ...this.page.fields } },
          // Submission is treated as irreversible — drives high blast-radius quorum.
          reversible: false,
          undo: null
        };
      }
      case "extract": {
        return {
          actionId: action.id,
          ok: true,
          observation: `Extracted content from ${this.page.url}`,
          postState: { url: this.page.url, extracted: this.text },
          reversible: true,
          undo: null
        };
      }
      default: {
        return {
          actionId: action.id,
          ok: false,
          observation: "Unknown action",
          error: "unsupported_action",
          reversible: false,
          undo: null
        };
      }
    }
  }
}

const defaultElements: DomSnapshot["elements"] = [
  { selector: "#search", role: "textbox", label: "Search", confidence: 0.9 },
  { selector: "#submit", role: "button", label: "Submit", confidence: 0.85 }
];
