import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelHostRole } from '@bike4mind/common/modelHub';

export type HostMode = 'system' | 'user';

export const SYSTEM_SOCKET_DIR = '/run/b4m-host';
export const SYSTEM_STATE_DIR = '/var/lib/b4m-host';
export const MANAGE_GROUP = 'b4m-host';
export const ADMIN_GROUP = 'b4m-host-admin';
/** Linux `sun_path` holds 108 bytes including the terminating NUL. */
export const MAX_SOCKET_PATH_BYTES = 107;

export interface SocketSpec {
  role: ModelHostRole;
  path: string;
  /** Members of this group get the socket's role; null keeps it to the service's own user. */
  group: string | null;
}

type Env = Record<string, string | undefined>;

function userRuntimeDir(env: Env): string | null {
  if (env.XDG_RUNTIME_DIR) return env.XDG_RUNTIME_DIR;
  const uid = process.getuid?.();
  return uid === undefined ? null : `/run/user/${uid}`;
}

export function defaultSocketDir(mode: HostMode, env: Env = process.env): string {
  if (mode === 'system') return SYSTEM_SOCKET_DIR;
  const runtime = userRuntimeDir(env);
  if (!runtime) throw new Error('XDG_RUNTIME_DIR is not set; pass --socket-dir');
  return join(runtime, 'b4m-host');
}

export function defaultStateDir(mode: HostMode, env: Env = process.env): string {
  if (mode === 'system') return SYSTEM_STATE_DIR;
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'b4m-host');
}

/** A system host has one socket per role, each gated by a group; a user host has one admin socket for its owner. */
export function socketSpecs(mode: HostMode, dir: string): SocketSpec[] {
  if (mode === 'user') return [{ role: 'admin', path: join(dir, 'admin.sock'), group: null }];
  return [
    { role: 'manage', path: join(dir, 'manage.sock'), group: MANAGE_GROUP },
    { role: 'admin', path: join(dir, 'admin.sock'), group: ADMIN_GROUP },
  ];
}

/** Sockets a client tries in order: the highest role first, a system host before a user one. */
export function dialCandidates(socketDir: string | undefined, env: Env = process.env): string[] {
  if (socketDir) return [join(socketDir, 'admin.sock'), join(socketDir, 'manage.sock')];
  const candidates = [join(SYSTEM_SOCKET_DIR, 'admin.sock'), join(SYSTEM_SOCKET_DIR, 'manage.sock')];
  const runtime = userRuntimeDir(env);
  if (runtime) candidates.push(join(runtime, 'b4m-host', 'admin.sock'));
  return candidates;
}

/** The gid of a group in `/etc/group`, or null when it has none there. */
export async function lookupGroupId(name: string, groupFile = '/etc/group'): Promise<number | null> {
  const text = await readFile(groupFile, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    const [group, , gid] = line.split(':');
    if (group === name && gid && /^\d+$/.test(gid)) return Number(gid);
  }
  return null;
}
