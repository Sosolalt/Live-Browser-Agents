import crypto from "node:crypto";
import { cosineSimilarity } from "../ports/embedder.js";
import type { Embedder } from "../ports/embedder.js";
import type { GraphBatch, GraphStore } from "./graphStore.js";
import { NATURAL_KEY_PROP } from "./graphStore.js";
import { DEFAULT_IMPORTANCE, ttlForNode } from "./kgTypes.js";
import type { EdgeType, KGEdge, KGNode, NodeType } from "./kgTypes.js";

// Background consolidation jobs. Each is deterministic given the store state and
// options, so they can be scheduled or run inline in tests.

export interface ConsolidationOptions {
  nowMs?: number;
  episodeMinActions?: number;
  conceptMinCluster?: number;
  conceptSimilarity?: number;
  entityMergeSimilarity?: number;
  skillMinSuccesses?: number;
  /** Decay score below which a node is demoted to the cold tier. */
  coldScoreThreshold?: number;
  recencyHalfLifeDays?: number;
}

export interface ConsolidationReport {
  episodesCreated: number;
  entitiesMerged: number;
  conceptsCreated: number;
  skillsPromoted: number;
  nodesCooled: number;
  nodesPurged: number;
  contradictionsResolved: number;
}

export interface ConsolidationEngineDeps {
  store: GraphStore;
  embedder: Embedder;
  clock?: () => number;
  newId?: () => string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class ConsolidationEngine {
  private readonly store: GraphStore;
  private readonly clock: () => number;
  private readonly newId: () => string;

  constructor(deps: ConsolidationEngineDeps) {
    this.store = deps.store;
    this.clock = deps.clock ?? (() => Date.now());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  async run(installId: string, options: ConsolidationOptions = {}): Promise<ConsolidationReport> {
    return {
      episodesCreated: await this.compactEpisodes(installId, options),
      entitiesMerged: await this.resolveEntities(installId, options),
      conceptsCreated: await this.formConcepts(installId, options),
      skillsPromoted: await this.promoteSkills(installId, options),
      contradictionsResolved: await this.resolveContradictions(installId, options),
      ...(await this.applyDecay(installId, options))
    };
  }

  /** Cluster a session's raw Actions into one episode Observation; cool the residue. */
  async compactEpisodes(installId: string, options: ConsolidationOptions = {}): Promise<number> {
    const minActions = options.episodeMinActions ?? 3;
    const now = options.nowMs ?? this.clock();
    const sessions = await this.store.listNodes(installId, { types: ["Session"] });
    let created = 0;
    for (const session of sessions) {
      const belongs = await this.store.neighbors(installId, session.id, { edgeTypes: ["BELONGS_TO"], direction: "in" });
      const actions = belongs.map((hit) => hit.node).filter((node) => node.type === "Action");
      if (actions.length < minActions) continue;
      if (actions.some((action) => action.properties.compacted === true)) continue;

      const episode = this.makeNode(installId, "Observation", `episode: ${actions.length} actions in ${session.label}`, {
        episode: true,
        actionCount: actions.length
      }, now);
      const edges: KGEdge[] = actions.map((action) => this.makeEdge(installId, "DERIVED_FROM", episode.id, action.id, now));
      // Demote raw actions to cold and mark compacted (drop sensory residue).
      const cooled = actions.map((action) => ({
        ...action,
        tier: "cold" as const,
        properties: { ...action.properties, compacted: true },
        updatedAt: now
      }));
      await this.store.applyBatch(installId, { upsertNodes: [episode, ...cooled], upsertEdges: edges });
      created += 1;
    }
    return created;
  }

  /** Merge duplicate entities across sessions; repoint edges to the canonical node. */
  async resolveEntities(installId: string, options: ConsolidationOptions = {}): Promise<number> {
    const threshold = options.entityMergeSimilarity ?? 0.97;
    const now = options.nowMs ?? this.clock();
    const entities = (await this.store.listNodes(installId, { types: ["Entity"] })).filter((node) => node.embedding);
    const merged = new Set<string>();
    let count = 0;

    for (let i = 0; i < entities.length; i += 1) {
      const canonical = entities[i];
      if (merged.has(canonical.id)) continue;
      for (let j = i + 1; j < entities.length; j += 1) {
        const candidate = entities[j];
        if (merged.has(candidate.id)) continue;
        if (canonical.properties.entityType !== candidate.properties.entityType) continue;
        const score = cosineSimilarity(canonical.embedding ?? [], candidate.embedding ?? []);
        if (score < threshold) continue;
        await this.mergeInto(installId, canonical, candidate, now);
        merged.add(candidate.id);
        count += 1;
      }
    }
    return count;
  }

  private async mergeInto(installId: string, canonical: KGNode, duplicate: KGNode, now: number): Promise<void> {
    const incident = await this.store.neighbors(installId, duplicate.id, { direction: "both" });
    const newEdges: KGEdge[] = [];
    const deleteEdgeIds: string[] = [];
    for (const hit of incident) {
      deleteEdgeIds.push(hit.edge.id);
      const from = hit.edge.from === duplicate.id ? canonical.id : hit.edge.from;
      const to = hit.edge.to === duplicate.id ? canonical.id : hit.edge.to;
      if (from === to) continue;
      newEdges.push({ ...this.makeEdge(installId, hit.edge.type, from, to, now), weight: hit.edge.weight });
    }
    const reinforced: KGNode = {
      ...canonical,
      importance: clamp01(canonical.importance + 0.05),
      accessCount: canonical.accessCount + duplicate.accessCount,
      updatedAt: now
    };
    const batch: GraphBatch = {
      upsertNodes: [reinforced],
      upsertEdges: newEdges,
      deleteNodeIds: [duplicate.id],
      deleteEdgeIds
    };
    await this.store.applyBatch(installId, batch);
  }

  /** Greedy embedding clusters become Concept nodes with ABSTRACTS edges. */
  async formConcepts(installId: string, options: ConsolidationOptions = {}): Promise<number> {
    const minCluster = options.conceptMinCluster ?? 3;
    const similarity = options.conceptSimilarity ?? 0.7;
    const now = options.nowMs ?? this.clock();
    const members = (await this.store.listNodes(installId, { types: ["Entity", "Observation"] })).filter(
      (node) => node.embedding && node.properties.episode !== true
    );

    const assigned = new Set<string>();
    let created = 0;
    for (const anchor of members) {
      if (assigned.has(anchor.id)) continue;
      const cluster = [anchor];
      assigned.add(anchor.id);
      for (const other of members) {
        if (assigned.has(other.id)) continue;
        if (cosineSimilarity(anchor.embedding ?? [], other.embedding ?? []) >= similarity) {
          cluster.push(other);
          assigned.add(other.id);
        }
      }
      if (cluster.length < minCluster) continue;
      const concept = this.makeNode(installId, "Concept", `concept: ${anchor.label}`, { size: cluster.length }, now);
      concept.embedding = anchor.embedding;
      const edges = cluster.map((member) => this.makeEdge(installId, "ABSTRACTS", concept.id, member.id, now));
      await this.store.applyBatch(installId, { upsertNodes: [concept], upsertEdges: edges });
      created += 1;
    }
    return created;
  }

  /** Task descriptions that succeeded >= N times become reusable Skill nodes. */
  async promoteSkills(installId: string, options: ConsolidationOptions = {}): Promise<number> {
    const minSuccesses = options.skillMinSuccesses ?? 2;
    const now = options.nowMs ?? this.clock();
    const tasks = (await this.store.listNodes(installId, { types: ["Task"] })).filter(
      (task) => task.properties.status === "done"
    );
    const groups = new Map<string, KGNode[]>();
    for (const task of tasks) {
      const key = normalize(String(task.properties.description ?? task.label));
      const group = groups.get(key) ?? [];
      group.push(task);
      groups.set(key, group);
    }
    let promoted = 0;
    for (const [key, group] of groups) {
      if (group.length < minSuccesses) continue;
      const naturalKey = `skill:${hash(key)}`;
      const existing = await this.store.findByNaturalKey(installId, "Skill", naturalKey);
      if (existing) continue;
      const skill = this.makeNode(installId, "Skill", `skill: ${group[0].label}`, {
        [NATURAL_KEY_PROP]: naturalKey,
        successes: group.length,
        template: group[0].properties.description ?? group[0].label
      }, now);
      const edges = group.map((task) => this.makeEdge(installId, "ABSTRACTS", skill.id, task.id, now));
      await this.store.applyBatch(installId, { upsertNodes: [skill], upsertEdges: edges });
      promoted += 1;
    }
    return promoted;
  }

  /** Keep the newest/highest-confidence Preference per key; SUPERSEDES the rest. */
  async resolveContradictions(installId: string, options: ConsolidationOptions = {}): Promise<number> {
    const now = options.nowMs ?? this.clock();
    const prefs = await this.store.listNodes(installId, { types: ["Preference"] });
    const groups = new Map<string, KGNode[]>();
    for (const pref of prefs) {
      const key = String(pref.properties.key ?? pref.label);
      const group = groups.get(key) ?? [];
      group.push(pref);
      groups.set(key, group);
    }
    let resolved = 0;
    for (const group of groups.values()) {
      const active = group.filter((pref) => pref.properties.superseded !== true);
      if (active.length < 2) continue;
      active.sort((a, b) => b.confidence - a.confidence || b.updatedAt - a.updatedAt);
      const winner = active[0];
      const losers = active.slice(1);
      const upsertNodes = losers.map((loser) => ({
        ...loser,
        properties: { ...loser.properties, superseded: true },
        updatedAt: now
      }));
      const edges = losers.map((loser) => this.makeEdge(installId, "SUPERSEDES", winner.id, loser.id, now));
      await this.store.applyBatch(installId, { upsertNodes, upsertEdges: edges });
      resolved += losers.length;
    }
    return resolved;
  }

  /** score = importance x recency x access_freq x confidence -> cool / purge. */
  async applyDecay(
    installId: string,
    options: ConsolidationOptions = {}
  ): Promise<{ nodesCooled: number; nodesPurged: number }> {
    const now = options.nowMs ?? this.clock();
    const coldThreshold = options.coldScoreThreshold ?? 0.08;
    const halfLife = options.recencyHalfLifeDays ?? 30;
    const all = await this.store.listNodes(installId);
    const cool: KGNode[] = [];
    const purgeIds: string[] = [];

    for (const node of all) {
      const ageDays = Math.max(0, (now - node.lastAccessedAt) / DAY_MS);
      const recency = Math.pow(0.5, ageDays / halfLife);
      const accessFreq = 1 - 1 / (1 + node.accessCount);
      const score = node.importance * recency * (0.2 + 0.8 * accessFreq) * node.confidence;
      const expired = now - node.lastAccessedAt > ttlForNode(node);
      if (expired && node.tier === "cold") {
        purgeIds.push(node.id);
      } else if (score < coldThreshold && node.tier === "hot") {
        cool.push({ ...node, tier: "cold", updatedAt: now });
      }
    }

    if (cool.length > 0) {
      await this.store.applyBatch(installId, { upsertNodes: cool, upsertEdges: [] });
    }
    if (purgeIds.length > 0) {
      await this.store.deleteNodes(installId, purgeIds);
    }
    return { nodesCooled: cool.length, nodesPurged: purgeIds.length };
  }

  private makeNode(
    installId: string,
    type: NodeType,
    label: string,
    properties: Record<string, unknown>,
    now: number
  ): KGNode {
    return {
      id: this.newId(),
      installId,
      type,
      label,
      properties,
      sealed: null,
      embedding: null,
      importance: DEFAULT_IMPORTANCE[type],
      confidence: 0.8,
      accessCount: 0,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      ttlMs: null,
      tier: "hot",
      provenance: "consolidation"
    };
  }

  private makeEdge(installId: string, type: EdgeType, from: string, to: string, now: number): KGEdge {
    return { id: this.newId(), installId, type, from, to, weight: 1, properties: {}, createdAt: now };
  }
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const normalize = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");
const hash = (value: string): string => crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
