/**
 * Folder-trust gate for the shared project-store builders. Both the headless
 * (`b4m -p`) path and the interactive bootstrap (buildSupportingStores) route
 * their agent-store construction and context loading through these helpers, so
 * this proves the gate holds for BOTH: an untrusted project contributes no
 * agents and no context file; a trusted one contributes both.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { ConfigStore } from '../storage/ConfigStore';
import { buildProjectAgentStore, loadProjectContext } from './projectStores';

const CONTEXT_MARKER = 'REPO-CONTEXT-MARKER-XYZ';

function globalConfigJson() {
  return JSON.stringify({
    version: '1.0.0',
    userId: 'test-user',
    defaultModel: 'claude-sonnet-4-6',
    mcpServers: [],
    preferences: { temperature: 0.7, autoSave: true, theme: 'dark', exportFormat: 'markdown' },
    tools: { enabled: [], disabled: [], config: {} },
    trustedTools: [],
  });
}

describe('projectStores folder-trust gate (shared by headless + interactive)', () => {
  let projectDir: string;
  let builtinDir: string;
  let globalConfigPath: string;
  let originalCwd: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of ['B4M_NO_PROJECT_CONFIG']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    originalCwd = process.cwd();
    const base = await fs.mkdtemp(path.join(tmpdir(), 'b4m-projstores-'));
    projectDir = path.join(base, 'proj');
    await fs.mkdir(path.join(projectDir, '.git'), { recursive: true }); // findProjectConfigDir marker
    const agentsDir = path.join(projectDir, '.claude', 'agents');
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(path.join(agentsDir, 'evil.md'), '---\ndescription: a repo agent\n---\nYou are a repo agent.\n');
    await fs.writeFile(path.join(projectDir, 'CLAUDE.md'), `# ${CONTEXT_MARKER}\n`);

    builtinDir = path.join(base, 'builtin');
    await fs.mkdir(builtinDir, { recursive: true });

    globalConfigPath = path.join(base, 'global', 'config.json');
    await fs.mkdir(path.dirname(globalConfigPath), { recursive: true });
    await fs.writeFile(globalConfigPath, globalConfigJson(), { mode: 0o600 });

    process.chdir(projectDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(path.dirname(projectDir), { recursive: true, force: true }).catch(() => {});
  });

  it('loads no repo agents and no repo context when the project is untrusted', async () => {
    const store = new ConfigStore(globalConfigPath);
    await store.load();
    expect(store.isProjectTrusted()).toBe(false);

    const agentStore = buildProjectAgentStore(builtinDir, store);
    await agentStore.loadAgents();
    expect(agentStore.hasAgent('evil')).toBe(false);

    const context = await loadProjectContext(store);
    expect(context.projectContext).toBeNull();
    expect(context.mergedContent).not.toContain(CONTEXT_MARKER);
  });

  it('loads repo agents and repo context once the project is trusted', async () => {
    const store = new ConfigStore(globalConfigPath);
    await store.load();
    await store.trustProject();
    expect(store.isProjectTrusted()).toBe(true);

    const agentStore = buildProjectAgentStore(builtinDir, store);
    await agentStore.loadAgents();
    expect(agentStore.hasAgent('evil')).toBe(true);

    const context = await loadProjectContext(store);
    expect(context.projectContext?.filename).toBe('CLAUDE.md');
    expect(context.mergedContent).toContain(CONTEXT_MARKER);
  });
});
