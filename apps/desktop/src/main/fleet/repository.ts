import { execFile } from 'node:child_process';
import { hostGitArgs } from '../git/hostGitArgs';
import { isRepositoryPart } from './activityContract';

export interface RepositoryName {
  owner: string;
  name: string;
}

export interface RemoteLocation extends RepositoryName {
  /** Lower-cased host, e.g. `github.com`. */
  host: string;
  /** Lower-cased full path without `.git`, so `a/sub/repo` and `b/sub/repo` differ. */
  path: string;
}

/**
 * Owner and name from a git remote URL: `git@host:owner/name.git`, `https://host/owner/name`,
 * `ssh://git@host/owner/name.git`. The host is dropped; only owner/name ever leave this machine.
 */
export function parseRemote(remote: string): RepositoryName | null {
  const location = parseRemoteLocation(remote);
  return location ? { owner: location.owner, name: location.name } : null;
}

/** As `parseRemote`, keeping the host so a caller can tell github.com from another server. */
export function parseRemoteLocation(remote: string): RemoteLocation | null {
  const trimmed = remote.trim();
  const scp = /^[^@\s/]+@([^:\s]+):(.+)$/.exec(trimmed);
  let host: string;
  let path: string;
  if (scp) {
    if (scp[2].startsWith('/') || scp[2].startsWith('~')) return null;
    host = scp[1];
    path = scp[2];
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(url.protocol) || !url.hostname)
      return null;
    host = url.hostname;
    path = url.pathname;
  }
  const parts = path
    .replace(/\.git\/?$/, '')
    .split('/')
    .filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, name] = parts.slice(-2);
  return isRepositoryPart(owner) && isRepositoryPart(name)
    ? { host: host.toLowerCase(), owner, name, path: parts.join('/').toLowerCase() }
    : null;
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
    execFile(
      'git',
      hostGitArgs(['-C', directory, 'config', '--get', 'remote.origin.url']),
      { timeout: 2000 },
      (err, stdout) => {
        resolve(err ? null : stdout.trim() || null);
      }
    );
  });
}
