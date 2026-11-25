import { randomUUID } from 'node:crypto';
import { link, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { restrictMode } from './auth/privateDirectory';

const HOST_ID_FILE_NAME = 'host-id';
const OWNER_ONLY_FILE = 0o600;

// Filesystems without hard links (exFAT, some network shares) refuse `link` with one of these.
const NO_HARD_LINKS = new Set(['ENOTSUP', 'EPERM', 'ENOSYS']);

const hostIdSchema = z.uuid();

async function readHostId(path: string): Promise<string | null> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = hostIdSchema.safeParse(contents.trim());
  // Never replaced silently: a new id would make every client see this machine as a new host.
  if (!parsed.success) throw new Error(`${path} does not hold a host id; remove it to give this host a new one`);
  return parsed.data;
}

async function createWithoutLink(path: string, created: string): Promise<string> {
  try {
    await writeFile(path, `${created}\n`, { flag: 'wx', mode: OWNER_ONLY_FILE });
    return created;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const raced = await readHostId(path);
    if (!raced) throw err;
    return raced;
  }
}

/**
 * This host's stable id: a random UUID made on first use and kept owner-only in
 * `dataDirectory`, so it survives restarts and upgrades but says nothing about the machine.
 * Two routes to the same home directory therefore resolve to one host.
 */
export async function loadHostId(dataDirectory: string): Promise<string> {
  const path = join(dataDirectory, HOST_ID_FILE_NAME);
  const existing = await readHostId(path);
  if (existing) {
    await restrictMode(path, OWNER_ONLY_FILE);
    return existing;
  }
  const created = randomUUID();
  // Written whole under a temp name and linked into place, so no process ever sees `host-id` empty.
  const temp = `${path}.${randomUUID()}`;
  try {
    await writeFile(temp, `${created}\n`, { flag: 'wx', mode: OWNER_ONLY_FILE });
    await link(temp, path);
    return created;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && NO_HARD_LINKS.has(code)) return createWithoutLink(path, created);
    // Another process made it first; theirs is the one that stays.
    if (code !== 'EEXIST') throw err;
    const raced = await readHostId(path);
    if (!raced) throw err;
    return raced;
  } finally {
    await rm(temp, { force: true });
  }
}
