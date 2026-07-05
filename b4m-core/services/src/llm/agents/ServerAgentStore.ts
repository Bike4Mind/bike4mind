import type { ServerAgentConfig, ServerAgentDefinition } from '@bike4mind/agents';
// import { ExploreAgent } from './ExploreAgent';
// import { PlanAgent } from './PlanAgent';
import { AnalystAgent } from './AnalystAgent';
import { CodeReviewAgent } from './CodeReviewAgent';
import { CoordinatorAgent } from './CoordinatorAgent';
import { GithubManagerAgent } from './GithubManagerAgent';
import { ProjectManagerAgent } from './ProjectManagerAgent';
import { ResearcherAgent } from './ResearcherAgent';

/**
 * Per-scope agent overlays. The agent executor pulls user-scoped and
 * org-scoped agents from the unified `agents` collection and
 * passes them to this store separately so precedence can be applied
 * deterministically.
 */
export interface ServerAgentStoreOverlays {
  /** User-scoped agents (matching the executing user's `userId`). */
  userAgents?: ServerAgentDefinition[];
  /** Organization-scoped agents (matching the execution's `organizationId`). */
  orgAgents?: ServerAgentDefinition[];
}

/**
 * Server-side agent store with factory-based agent definitions.
 *
 * Constructed per-request with a config to inject per-user data (e.g., selected repositories).
 */
export class ServerAgentStore {
  private agents: Map<string, ServerAgentDefinition>;

  /**
   * @param config Per-request agent factory config (e.g., user's GitHub repos).
   * @param overlays Per-scope agent overlays from the unified `agents`
   *   collection. Precedence on name collision: **org > user > built-in**,
   *   mirroring the CLI's `project > home > built-in` convention. An
   *   org-shared agent always overrides a user's personal version of the
   *   same name so admins can enforce canonical configurations.
   */
  constructor(config: ServerAgentConfig, overlays: ServerAgentStoreOverlays = {}) {
    const builtInAgents: ServerAgentDefinition[] = [
      // For now disable explore and plan agents as it is much faster if the parent llm handles this.
      // ExploreAgent(),
      // PlanAgent(),
      AnalystAgent(config),
      CodeReviewAgent(config),
      CoordinatorAgent(config),
      GithubManagerAgent(config),
      ProjectManagerAgent(config),
      ResearcherAgent(config),
    ];
    const map = new Map<string, ServerAgentDefinition>();
    // Order matters: later writes win on key collision. Built-ins are the
    // baseline; user agents override built-ins; org agents override user.
    for (const agent of builtInAgents) map.set(agent.name, agent);
    for (const agent of overlays.userAgents ?? []) map.set(agent.name, agent);
    for (const agent of overlays.orgAgents ?? []) map.set(agent.name, agent);
    this.agents = map;
  }

  getAgent(name: string): ServerAgentDefinition | undefined {
    return this.agents.get(name);
  }

  getAllAgents(): ServerAgentDefinition[] {
    return Array.from(this.agents.values());
  }

  getAgentNames(): string[] {
    return Array.from(this.agents.keys());
  }

  hasAgent(name: string): boolean {
    return this.agents.has(name);
  }

  /**
   * Return a new store containing only the named agents.
   * Used for persona-based enforcement: e.g. @dev only sees github_manager + code_review.
   */
  getFilteredStore(allowedAgentNames: string[]): ServerAgentStore {
    const store = Object.create(ServerAgentStore.prototype) as ServerAgentStore;
    store.agents = new Map(allowedAgentNames.filter(n => this.agents.has(n)).map(n => [n, this.agents.get(n)!]));
    return store;
  }

  /**
   * Get the deduplicated list of MCP server names that are exclusive to agents.
   * Derived from each agent's `exclusiveMcpServers` field.
   */
  getExclusiveMcpServers(): string[] {
    const servers = new Set<string>();
    for (const agent of this.agents.values()) {
      if (agent.exclusiveMcpServers) {
        for (const s of agent.exclusiveMcpServers) {
          servers.add(s);
        }
      }
    }
    return Array.from(servers);
  }
}
