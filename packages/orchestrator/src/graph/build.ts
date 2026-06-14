import { END, START, StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { NodeDeps } from "./nodes.js";
import {
  criticNode,
  memoryNode,
  perceptionNode,
  plannerNode,
  researcherNode,
  verifierNode,
  workerNode
} from "./nodes.js";
import { OrchestratorState, currentTask } from "./state.js";
import type { OrchestratorStateType } from "./state.js";

const routeFromPlanner = (state: OrchestratorStateType): "critic" | typeof END => {
  if (state.status !== "running") return END;
  return currentTask(state) ? "critic" : END;
};

const routeFromCritic = (state: OrchestratorStateType): "navigator" | "form" | "extractor" | "planner" => {
  if (state.status === "running" && state.criticDecision?.approved) {
    const task = currentTask(state);
    if (task) return task.agent;
  }
  return "planner";
};

const routeFromVerifier = (state: OrchestratorStateType): "memory" | "planner" =>
  state.verifierResult?.passed ? "memory" : "planner";

/**
 * Builds the autonomous supervisor graph:
 *
 *   START ─▶ perception ┐
 *   START ─▶ researcher ┘─▶ planner ─(task)▶ critic ─(approved)▶ navigator/form/extractor
 *                          ▲      │                                        │
 *                          │      └─(no task / terminated)▶ END            ▼
 *                          │                                            verifier
 *                          ├──────────(verify fail → replan)────────────┤
 *                          └──────────────── memory ◀─(verify pass)──────┘
 *
 * Perception ‖ Researcher fan out in parallel and join at the planner.
 */
export const buildGraph = (deps: NodeDeps, checkpointer?: BaseCheckpointSaver) => {
  const builder = new StateGraph(OrchestratorState)
    .addNode("perception", perceptionNode(deps))
    .addNode("researcher", researcherNode(deps))
    .addNode("planner", plannerNode(deps))
    .addNode("critic", criticNode(deps))
    .addNode("navigator", workerNode("navigator", deps))
    .addNode("form", workerNode("form", deps))
    .addNode("extractor", workerNode("extractor", deps))
    .addNode("verifier", verifierNode(deps))
    .addNode("memory", memoryNode(deps))
    .addEdge(START, "perception")
    .addEdge(START, "researcher")
    .addEdge("perception", "planner")
    .addEdge("researcher", "planner")
    .addConditionalEdges("planner", routeFromPlanner, ["critic", END])
    .addConditionalEdges("critic", routeFromCritic, ["navigator", "form", "extractor", "planner"])
    .addEdge("navigator", "verifier")
    .addEdge("form", "verifier")
    .addEdge("extractor", "verifier")
    .addConditionalEdges("verifier", routeFromVerifier, ["memory", "planner"])
    .addEdge("memory", "planner");

  return builder.compile(checkpointer ? { checkpointer } : {});
};
