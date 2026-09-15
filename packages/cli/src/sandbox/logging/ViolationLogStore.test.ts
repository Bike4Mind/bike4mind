import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { ViolationLogStore } from './ViolationLogStore.js';
import type { SandboxViolation } from '../types.js';

describe('ViolationLogStore', () => {
  let tmpDir: string;
  let storePath: string;
  let store: ViolationLogStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'violation-test-'));
    storePath = path.join(tmpDir, 'violations.jsonl');
    store = new ViolationLogStore(storePath);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeViolation(overrides?: Partial<SandboxViolation>): SandboxViolation {
    return {
      type: 'filesystem',
      command: 'cat /etc/shadow',
      blockedBy: 'sandbox',
      timestamp: new Date(),
      ...overrides,
    };
  }

  it('record creates file and appends JSONL entry', async () => {
    await store.record(makeViolation());

    const content = await fs.readFile(storePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.type).toBe('filesystem');
    expect(entry.command).toBe('cat /etc/shadow');
    expect(entry.blockedBy).toBe('sandbox');
    expect(typeof entry.timestamp).toBe('number');
  });

  it('record appends multiple entries', async () => {
    await store.record(makeViolation({ command: 'cmd1' }));
    await store.record(makeViolation({ command: 'cmd2' }));
    await store.record(makeViolation({ command: 'cmd3' }));

    const content = await fs.readFile(storePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('load returns newest-first', async () => {
    const t1 = new Date('2024-01-01T00:00:00Z');
    const t2 = new Date('2024-01-02T00:00:00Z');
    const t3 = new Date('2024-01-03T00:00:00Z');

    await store.record(makeViolation({ command: 'first', timestamp: t1 }));
    await store.record(makeViolation({ command: 'second', timestamp: t2 }));
    await store.record(makeViolation({ command: 'third', timestamp: t3 }));

    // Force cache reload
    const freshStore = new ViolationLogStore(storePath);
    const entries = await freshStore.load();

    expect(entries[0].command).toBe('third');
    expect(entries[1].command).toBe('second');
    expect(entries[2].command).toBe('first');
  });

  it('load handles missing file (returns [])', async () => {
    const entries = await store.load();
    expect(entries).toEqual([]);
  });

  it('load skips malformed JSONL lines', async () => {
    const goodEntry = JSON.stringify({
      type: 'filesystem',
      command: 'good',
      blockedBy: 'sandbox',
      timestamp: Date.now(),
    });
    await fs.writeFile(storePath, `${goodEntry}\n{bad json\n${goodEntry}\n`, 'utf-8');

    const freshStore = new ViolationLogStore(storePath);
    const entries = await freshStore.load();
    expect(entries).toHaveLength(2);
  });

  it('getRecent defaults to 50', async () => {
    // Record 60 entries
    for (let i = 0; i < 60; i++) {
      await store.record(makeViolation({ command: `cmd-${i}` }));
    }

    const freshStore = new ViolationLogStore(storePath);
    const recent = await freshStore.getRecent();
    expect(recent).toHaveLength(50);
  });

  it('getRecent respects count parameter', async () => {
    for (let i = 0; i < 10; i++) {
      await store.record(makeViolation({ command: `cmd-${i}` }));
    }

    const freshStore = new ViolationLogStore(storePath);
    const recent = await freshStore.getRecent(3);
    expect(recent).toHaveLength(3);
  });

  it('countByType counts correctly', async () => {
    await store.record(makeViolation({ type: 'filesystem' }));
    await store.record(makeViolation({ type: 'filesystem' }));
    await store.record(makeViolation({ type: 'network', domain: 'evil.com', blockedBy: 'proxy' }));

    const freshStore = new ViolationLogStore(storePath);
    const counts = await freshStore.countByType();
    expect(counts).toEqual({ filesystem: 2, network: 1 });
  });

  it('clear removes file and resets cache', async () => {
    await store.record(makeViolation());
    expect((await store.load()).length).toBeGreaterThan(0);

    await store.clear();

    const entries = await store.load();
    expect(entries).toEqual([]);

    // File should not exist
    await expect(fs.access(storePath)).rejects.toThrow();
  });

  it('record includes optional fields only when present', async () => {
    await store.record(
      makeViolation({
        path: '/etc/shadow',
        detail: 'deny file-read-data',
      })
    );

    const content = await fs.readFile(storePath, 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.path).toBe('/etc/shadow');
    expect(entry.detail).toBe('deny file-read-data');
    expect(entry.domain).toBeUndefined();
  });

  it('record with network violation includes domain', async () => {
    await store.record(
      makeViolation({
        type: 'network',
        domain: 'evil.com',
        blockedBy: 'proxy',
        detail: 'Blocked CONNECT to evil.com',
      })
    );

    const content = await fs.readFile(storePath, 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.type).toBe('network');
    expect(entry.domain).toBe('evil.com');
    expect(entry.blockedBy).toBe('proxy');
  });

  it('second load returns from cache', async () => {
    await store.record(makeViolation());

    const first = await store.load();
    const second = await store.load();
    // Same array reference = from cache
    expect(first).toBe(second);
  });
});
