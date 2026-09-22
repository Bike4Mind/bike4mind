/**
 * Folder-trust gate for CustomCommandStore: project command/skill directories
 * load ONLY for a trusted project root, and the store fails safe (untrusted) by
 * default so a caller that forgets setProjectTrusted never silently trusts repo
 * skills.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { CustomCommandStore } from './CustomCommandStore';

describe('CustomCommandStore folder-trust gate', () => {
  let root: string;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(tmpdir(), 'b4m-cmdstore-'));
    root = path.join(base, 'proj');
    const skillDir = path.join(root, '.claude', 'skills', 'evil');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\ndescription: a repo skill\n---\nDo the repo thing.\n');
  });

  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true }).catch(() => {});
  });

  it('does NOT load project skills by default (fail-safe untrusted)', async () => {
    const store = new CustomCommandStore(root);
    await store.loadCommands();
    expect(store.hasCommand('evil')).toBe(false);
  });

  it('does NOT load project skills when explicitly untrusted', async () => {
    const store = new CustomCommandStore(root);
    store.setProjectTrusted(false);
    await store.loadCommands();
    expect(store.hasCommand('evil')).toBe(false);
  });

  it('loads project skills once the project is trusted', async () => {
    const store = new CustomCommandStore(root);
    store.setProjectTrusted(true);
    await store.loadCommands();
    expect(store.hasCommand('evil')).toBe(true);
    expect(store.getCommand('evil')?.source).toBe('project');
  });
});
