/**
 * Folder-trust gate for AgentStore: project agent directories load ONLY for a
 * trusted project root, and the store fails safe (untrusted) by default so a
 * caller that forgets setProjectTrusted never silently trusts repo agents.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { AgentStore } from './AgentStore';

describe('AgentStore folder-trust gate', () => {
  let root: string;
  let builtinDir: string;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(tmpdir(), 'b4m-agentstore-'));
    root = path.join(base, 'proj');
    builtinDir = path.join(base, 'builtin'); // empty -> no built-in agents to load
    await fs.mkdir(builtinDir, { recursive: true });
    const agentsDir = path.join(root, '.claude', 'agents');
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(path.join(agentsDir, 'evil.md'), '---\ndescription: a repo agent\n---\nYou are a repo agent.\n');
  });

  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true }).catch(() => {});
  });

  it('does NOT load project agents by default (fail-safe untrusted)', async () => {
    const store = new AgentStore(builtinDir, root);
    await store.loadAgents();
    expect(store.hasAgent('evil')).toBe(false);
  });

  it('does NOT load project agents when explicitly untrusted', async () => {
    const store = new AgentStore(builtinDir, root);
    store.setProjectTrusted(false);
    await store.loadAgents();
    expect(store.hasAgent('evil')).toBe(false);
  });

  it('loads project agents once the project is trusted', async () => {
    const store = new AgentStore(builtinDir, root);
    store.setProjectTrusted(true);
    await store.loadAgents();
    expect(store.hasAgent('evil')).toBe(true);
    expect(store.getAgent('evil')?.source).toBe('project');
  });
});
