/**
 * A long-lived caller (the desktop's skill catalog) rescans whenever a skill directory changes.
 * With a shared file cache an unchanged file is not re-parsed, so a broken one is reported once
 * per edit rather than once per scan.
 *
 * Hermetic: os.homedir is mocked to an empty temp dir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { CustomCommandStore, type CachedCommandFile } from './CustomCommandStore.js';

let projectRoot: string;
let fakeHome: string;

async function writeSkill(name: string, content: string): Promise<string> {
  const dir = path.join(fakeHome, '.claude', 'skills', name);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  await fs.writeFile(file, content);
  return file;
}

async function scan(fileCache: Map<string, CachedCommandFile>): Promise<CustomCommandStore> {
  const store = new CustomCommandStore(projectRoot, { fileCache });
  await store.loadCommands();
  return store;
}

function warningsAbout(warn: { mock: { calls: unknown[][] } }, text: string): number {
  return warn.mock.calls.filter(call => String(call[0]).includes(text)).length;
}

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'b4m-cmdcache-proj-'));
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'b4m-cmdcache-home-'));
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of [projectRoot, fakeHome]) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

describe('CustomCommandStore file cache', () => {
  it('retries a transient file read failure without requiring a file edit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = await writeSkill('recover', '---\ndescription: recovered\n---\nBody\n');
    const originalRead = fs.readFile.bind(fs);
    let failed = false;
    const read = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (args[0] === file && !failed) {
        failed = true;
        throw new Error('Temporary I/O failure');
      }
      return originalRead(...args);
    });
    const fileCache = new Map<string, CachedCommandFile>();

    expect((await scan(fileCache)).hasCommand('recover')).toBe(false);
    expect((await scan(fileCache)).getCommand('recover')?.description).toBe('recovered');
    expect(read.mock.calls.filter(call => call[0] === file)).toHaveLength(2);
  });

  it('preserves a newer cache entry when an older read fails after a file edit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = await writeSkill('updated', '---\ndescription: old\n---\nBody\n');
    const originalRead = fs.readFile.bind(fs);
    let releaseRead!: () => void;
    const paused = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    let announceRead!: () => void;
    const started = new Promise<void>(resolve => {
      announceRead = resolve;
    });
    let firstRead = true;
    const read = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (args[0] === file && firstRead) {
        firstRead = false;
        announceRead();
        await paused;
        throw new Error('Older read failed');
      }
      return originalRead(...args);
    });
    const fileCache = new Map<string, CachedCommandFile>();
    const olderScan = scan(fileCache);
    await started;

    // Different size guarantees this scan does not share the older pending read.
    await fs.writeFile(file, '---\ndescription: updated successfully\n---\nBody\n');
    expect((await scan(fileCache)).getCommand('updated')?.description).toBe('updated successfully');
    releaseRead();
    await olderScan;

    expect((await scan(fileCache)).getCommand('updated')?.description).toBe('updated successfully');
    expect(read.mock.calls.filter(call => call[0] === file)).toHaveLength(2);
  });

  it('shares a pending parse without treating it as a skipped file', async () => {
    const file = await writeSkill('shared', '---\ndescription: shared\n---\nBody\n');
    const originalRead = fs.readFile.bind(fs);
    let releaseRead!: () => void;
    const paused = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    let announceRead!: () => void;
    const started = new Promise<void>(resolve => {
      announceRead = resolve;
    });
    const read = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (args[0] === file) {
        announceRead();
        await paused;
      }
      return originalRead(...args);
    });
    const fileCache = new Map<string, CachedCommandFile>();
    const first = scan(fileCache);
    await started;
    const second = scan(fileCache);
    await new Promise(resolve => setTimeout(resolve, 20));
    releaseRead();
    const stores = await Promise.all([first, second]);
    for (const store of stores) expect(store.hasCommand('shared')).toBe(true);
    expect(read.mock.calls.filter(call => call[0] === file)).toHaveLength(1);
  });

  it('warns about a broken file once, not on every scan, and again once it is edited', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = await writeSkill('broken', '---\ncontext: sideways\n---\nBody\n');
    const fileCache = new Map<string, CachedCommandFile>();

    await scan(fileCache);
    await scan(fileCache);
    expect(warningsAbout(warn, 'Invalid frontmatter')).toBe(1);

    await fs.writeFile(file, '---\ncontext: diagonal\n---\nEdited\n');
    const later = new Date(Date.now() + 5000);
    await fs.utimes(file, later, later);
    const store = await scan(fileCache);
    expect(warningsAbout(warn, 'Invalid frontmatter')).toBe(2);
    expect(store.getCommand('broken')?.description).toBe('Edited');
  });

  it('serves an unchanged file from the cache and still drops one that was deleted', async () => {
    await writeSkill('keep', '---\ndescription: kept\n---\nBody\n');
    const gone = await writeSkill('gone', '---\ndescription: gone\n---\nBody\n');
    const fileCache = new Map<string, CachedCommandFile>();
    await scan(fileCache);

    const read = vi.spyOn(fs, 'readFile');
    await fs.rm(path.dirname(gone), { recursive: true });
    const store = await scan(fileCache);

    expect(read).not.toHaveBeenCalled();
    expect(store.getCommand('keep')?.description).toBe('kept');
    expect(store.hasCommand('gone')).toBe(false);
  });

  it('remembers a skipped export as skipped', async () => {
    await writeSkill('exported', '---\n# Bike4Mind-Source: https://app.example/skills/1\nname: e\n---\nBody\n');
    const fileCache = new Map<string, CachedCommandFile>();
    await scan(fileCache);
    const store = await scan(fileCache);
    expect(store.hasCommand('exported')).toBe(false);
  });
});
