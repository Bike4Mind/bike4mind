import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  await original.save({ text: 'old history' });
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
