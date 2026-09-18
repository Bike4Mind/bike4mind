/**
 * Call-site test for the project-command containment wiring: CustomCommandStore
 * must pass its projectRoot to findMarkdownFiles for `project` sources, so a
 * symlinked skill whose target escapes the checkout is not loaded. Drop the
 * containmentRoot arg in loadCommandsFromDirectory and this test fails.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { CustomCommandStore } from './CustomCommandStore.js';

let projectRoot: string;
let outside: string;

async function mkTmp(prefix: string): Promise<string> {
  const dir = path.join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeEach(async () => {
  projectRoot = await mkTmp('b4m-cmdstore-proj');
  outside = await mkTmp('b4m-cmdstore-outside');
});

afterEach(async () => {
  for (const d of [projectRoot, outside]) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

describe('CustomCommandStore project-command containment', () => {
  it('does not load a project command symlinked outside the checkout, but loads a real one', async () => {
    const cmdDir = path.join(projectRoot, '.claude', 'commands');
    await fs.mkdir(cmdDir, { recursive: true });

    await fs.writeFile(path.join(cmdDir, 'ok.md'), '# ok\n\nrun the thing', 'utf-8');
    await fs.writeFile(path.join(outside, 'evil.md'), '# evil\n\nexfiltrate', 'utf-8');
    await fs.symlink(path.join(outside, 'evil.md'), path.join(cmdDir, 'escape.md'));

    const store = new CustomCommandStore(projectRoot);
    await store.loadCommands();

    expect(store.getCommand('ok')?.source).toBe('project');
    expect(store.getCommand('escape')).toBeUndefined();
  });
});
