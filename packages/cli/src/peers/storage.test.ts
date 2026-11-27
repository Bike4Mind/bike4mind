import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PeerStorage } from './storage.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'b4m-peer-storage-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

it('persists private atomic snapshots and rejects unsafe file permissions', async () => {
  const storage = new PeerStorage(root, 'incarnation');
  await storage.init();
  expect(await storage.load()).toBeUndefined();
  await storage.save({ version: 1, text: 'saved' });
  expect(await storage.load()).toEqual({ version: 1, text: 'saved' });
  const file = path.join(root, 'inboxes', 'incarnation.json');
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  await fs.chmod(file, 0o644);
  await expect(storage.load()).rejects.toThrow('Unsafe');
  await expect(storage.save({ overwritten: true })).rejects.toThrow('Unsafe');
});

it('refuses symlink inbox files and path traversal identities', async () => {
  expect(() => new PeerStorage(root, '../outside')).toThrow('Invalid');
  const storage = new PeerStorage(root, 'incarnation');
  await storage.init();
  const victim = path.join(root, 'victim');
  await fs.writeFile(victim, 'untouched');
  await fs.symlink(victim, path.join(root, 'inboxes', 'incarnation.json'));
  await expect(storage.save({ bad: true })).rejects.toThrow('Unsafe');
  expect(await fs.readFile(victim, 'utf8')).toBe('untouched');
});

it('sweeps expired historical snapshots without following unrelated symlinks', async () => {
  const original = new PeerStorage(root, 'original');
  await original.init();
  await original.save(snapshot());
  const expired = path.join(root, 'inboxes', 'original.json');
  const now = Date.now();
  await fs.utimes(expired, new Date(now - 8 * 24 * 60 * 60 * 1000), new Date(now - 8 * 24 * 60 * 60 * 1000));
  const victim = path.join(root, 'victim');
  await fs.writeFile(victim, 'preserved');
  await fs.symlink(victim, path.join(root, 'inboxes', 'linked.json'));
  const current = new PeerStorage(root, 'current');
  await current.init();
  expect(await current.history(now)).toEqual([]);
  await expect(fs.stat(expired)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(victim, 'utf8')).toBe('preserved');
});

function snapshot() {
  return {
    version: 1,
    identity: {
      id: 'old',
      generation: 'old',
      threadId: 'old',
      name: 'history',
      accountId: 'account',
      projectId: 'project',
    },
    incoming: [],
    outgoing: [],
  };
}

it('sweeps more than 4096 expired managed histories without blocking enrollment', async () => {
  const current = new PeerStorage(root, 'current');
  await current.init();
  const now = Date.now();
  const old = new Date(now - 8 * 24 * 60 * 60 * 1000);
  await Promise.all(
    Array.from({ length: 4097 }, async (_, index) => {
      const file = path.join(root, 'inboxes', `old-${index}.json`);
      await fs.writeFile(file, JSON.stringify(snapshot()), { mode: 0o600 });
      await fs.utimes(file, old, old);
    })
  );
  const orphan = path.join(root, 'inboxes', `orphan.json.${randomUUID()}.tmp`);
  await fs.writeFile(orphan, 'unfinished private snapshot', { mode: 0o600 });
  await fs.utimes(orphan, old, old);
  const unrelated = path.join(root, 'inboxes', 'unrelated.txt');
  await fs.writeFile(unrelated, 'preserved');
  expect(await current.history(now)).toEqual([]);
  expect(await fs.readdir(path.join(root, 'inboxes'))).toEqual(['unrelated.txt']);
  await current.save(snapshot());
  expect(await current.load()).toEqual(snapshot());
}, 15_000);

it('preserves expired snapshots owned by an active original execution', async () => {
  const original = new PeerStorage(root, 'original');
  await original.init();
  await original.save({
    ...snapshot(),
    writer: { token: randomUUID(), processId: process.pid, activeMessageId: 'in-flight' },
  });
  const file = path.join(root, 'inboxes', 'original.json');
  const now = Date.now();
  const old = new Date(now - 8 * 24 * 60 * 60 * 1000);
  await fs.utimes(file, old, old);
  const current = new PeerStorage(root, 'current');
  await current.init();
  expect(await current.history(now)).toHaveLength(1);
  expect(await fs.readFile(file, 'utf8')).toContain('in-flight');
});
