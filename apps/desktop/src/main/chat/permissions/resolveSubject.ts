import { realpathSync } from 'node:fs';
import { readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { isMissingPathError, MAX_LINK_HOPS, type NearestPath } from '../tools/paths';
import type { PermissionSubject } from './rules';

// Mirrors nativeOrJsRealpath in ../tools/paths: win32 volumes outside the mount manager throw EISDIR.
async function realpathOrJs(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EISDIR') throw error;
    return realpathSync(path);
  }
}

export async function physicalPath(path: string): Promise<string> {
  return (await nearest(path, { hops: 0 })).path;
}

// Mirrors nearestSync in ../tools/paths, throwing where it returns null.
async function nearest(path: string, walk: { hops: number }): Promise<NearestPath> {
  try {
    return { path: await realpathOrJs(path), exists: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if ((code !== 'ENAMETOOLONG' && !isMissingPathError(code, path)) || dirname(path) === path) throw error;
  }
  const parent = await nearest(dirname(path), walk);
  const name = basename(path);
  const candidate = join(parent.path, name);
  if (!parent.exists) return { path: candidate, exists: false };
  let target: string;
  try {
    target = await readlink(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EINVAL') return { path: await realpathOrJs(candidate), exists: true };
    if (isMissingPathError(code, name)) return { path: candidate, exists: false };
    throw error;
  }
  // realpath cannot follow a dangling link, but a write will still follow it to create its target.
  if (++walk.hops > MAX_LINK_HOPS) {
    throw Object.assign(new Error(`ELOOP: too many symbolic links, resolve '${path}'`), { code: 'ELOOP' });
  }
  return nearest(isAbsolute(target) ? target : `${parent.path}${sep}${target}`, walk);
}

// Also the path's own physical location: an unlink acts on a final link, not on its target.
async function physicalSpellings(path: string): Promise<string[]> {
  const target = await physicalPath(path);
  const parent = dirname(path);
  if (!isAbsolute(path) || parent === path) return [target];
  return [target, join(await physicalPath(parent), basename(path))];
}

/** Check both the requested name and its target, including symlinked parents of new files. */
export async function resolveSubject(subject: PermissionSubject): Promise<PermissionSubject> {
  const paths = subject.paths;
  const shellPaths = subject.shell?.paths;
  if (!paths && !shellPaths) return subject;
  const resolved = (await Promise.all((paths ?? []).map(physicalSpellings))).flat();
  const resolvedShell = (await Promise.all((shellPaths ?? []).map(physicalSpellings))).flat();
  return {
    ...subject,
    ...(paths ? { paths: [...new Set([...paths, ...resolved])] } : {}),
    ...(subject.shell && shellPaths
      ? { shell: { ...subject.shell, paths: [...new Set([...shellPaths, ...resolvedShell])] } }
      : {}),
  };
}
