/**
 * Call-site test for the project-agent containment wiring: AgentStore must pass
 * its projectRoot to findMarkdownFiles for `project` sources, so a symlinked agent
 * whose target escapes the checkout is not loaded. Drop the containmentRoot arg in
 * loadAgentsFromDirectory and this test fails (the escaping agent loads).
 *
 * Hermetic: os.homedir is mocked to an empty temp dir so a machine-local global
 * agent cannot leak into these assertions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { AgentStore } from './AgentStore.js';

const VALID_AGENT = '---\ndescription: an agent\n---\n\nSystem prompt body.';

let projectRoot: string;
let outside: string;
let builtinDir: string;
let fakeHome: string;

async function mkTmp(prefix: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeEach(async () => {
  projectRoot = await mkTmp('b4m-agentstore-proj');
  outside = await mkTmp('b4m-agentstore-outside');
  builtinDir = await mkTmp('b4m-agentstore-builtin');
  fakeHome = await mkTmp('b4m-agentstore-home');
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of [projectRoot, outside, builtinDir, fakeHome]) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

describe('AgentStore project-agent containment', () => {
  it('does not load a project agent symlinked outside the checkout, but loads a real one', async () => {
    const agentsDir = path.join(projectRoot, '.claude', 'agents');
    await fs.mkdir(agentsDir, { recursive: true });

    // A real in-tree agent, and a symlink pointing at a valid agent outside the root.
    await fs.writeFile(path.join(agentsDir, 'ok.md'), VALID_AGENT, 'utf-8');
    await fs.writeFile(path.join(outside, 'evil.md'), VALID_AGENT, 'utf-8');
    await fs.symlink(path.join(outside, 'evil.md'), path.join(agentsDir, 'escape.md'));

    const store = new AgentStore(builtinDir, projectRoot);
    await store.loadAgents();

    expect(store.hasAgent('ok')).toBe(true);
    expect(store.hasAgent('escape')).toBe(false);
  });
});
