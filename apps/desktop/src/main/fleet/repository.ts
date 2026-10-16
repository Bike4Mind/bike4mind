import { execFile } from 'node:child_process';
import { isRepositoryPart } from './activityContract';

export interface RepositoryName {
  owner: string;
  name: string;
}

/**
 * Owner and name from a git remote URL: `git@host:owner/name.git`, `https://host/owner/name`,
 * `ssh://git@host/owner/name.git`. The host is dropped; only owner/name ever leave this machine.
 */
export function parseRemote(remote: string): RepositoryName | null {
  const trimmed = remote.trim();
  const scp = /^[^@\s/]+@[^:\s]+:(.+)$/.exec(trimmed);
  let path: string;
  if (scp) {
    path = scp[1];
  } else {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      return null;
    }
  }
  const parts = path
    .replace(/\.git\/?$/, '')
    .split('/')
    .filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, name] = parts.slice(-2);
  return isRepositoryPart(owner) && isRepositoryPart(name) ? { owner, name } : null;
}

const CACHE_MS = 10 * 60_000;

/** A working directory's `origin` remote as owner/name, cached briefly per directory. */
export function createRepositoryResolver(
  readRemote: (directory: string) => Promise<string | null> = gitOriginUrl,
  now: () => number = Date.now
): (directory: string) => Promise<RepositoryName | null> {
  const cache = new Map<string, { at: number; value: RepositoryName | null }>();
  return async directory => {
    const hit = cache.get(directory);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    const remote = await readRemote(directory).catch(() => null);
    const value = remote ? parseRemote(remote) : null;
    cache.set(directory, { at: now(), value });
    return value;
  };
}

function gitOriginUrl(directory: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile('git', ['-C', directory, 'config', '--get', 'remote.origin.url'], { timeout: 2000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}
