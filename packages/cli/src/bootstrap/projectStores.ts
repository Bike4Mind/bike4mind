import { AgentStore } from '../agents/AgentStore.js';
import type { ConfigStore } from '../storage';
import { loadContextFiles, type ContextLoadResult } from '../utils/contextLoader';

/**
 * Build the project AgentStore with the folder-trust gate wired from the
 * ConfigStore, but NOT yet loaded (the caller runs `loadAgents()`).
 *
 * Centralizes the trust wiring so the headless (`b4m -p`) and interactive
 * bootstrap paths can't drift: an untrusted project must contribute no agents
 * in EITHER path. Pairs with `loadProjectContext` below - must stay in sync.
 */
export function buildProjectAgentStore(builtinAgentsDir: string, configStore: ConfigStore): AgentStore {
  const projectDir = configStore.getProjectConfigDir();
  const store = new AgentStore(builtinAgentsDir, projectDir ?? process.cwd());
  store.setProjectTrusted(configStore.isProjectTrusted());
  return store;
}

/**
 * Load the project + global context files with the folder-trust gate applied:
 * an untrusted project passes `null` so its CLAUDE.md/AGENTS.md is never
 * injected. Same invariant as `buildProjectAgentStore`, shared by the headless
 * and interactive paths.
 */
export function loadProjectContext(configStore: ConfigStore): Promise<ContextLoadResult> {
  const projectDir = configStore.getProjectConfigDir();
  return loadContextFiles(configStore.isProjectTrusted() ? projectDir : null);
}
