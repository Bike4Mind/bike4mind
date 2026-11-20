import { realpathSync } from 'node:fs';
import { readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import {
  isMissingNameError,
  isMissingPathError,
  MAX_LINK_HOPS,
  MAX_WALK_NAMES,
  type NearestPath,
  type NearestWalk,
} from '../tools/paths';
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
  return (await nearest(path, { hops: 0, names: 0 })).path;
}

const unresolvable = (code: string, reason: string, path: string): Error =>
  Object.assign(new Error(`${code}: ${reason}, resolve '${path}'`), { code });

// Mirrors nearestSync in ../tools/paths, throwing where it returns null.
async function nearest(path: string, walk: NearestWalk): Promise<NearestPath> {
  try {
    return { path: await realpathOrJs(path), exists: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if ((code !== 'ENAMETOOLONG' && !isMissingPathError(code, path)) || dirname(path) === path) throw error;
  }
  if (++walk.names > MAX_WALK_NAMES) throw unresolvable('ENAMETOOLONG', 'too many names', path);
  const parent = await nearest(dirname(path), walk);
  const name = basename(path);
  const candidate = join(parent.path, name);
  // Nothing under a missing folder can be a link, but `..` climbs back out to where one can be.
  if (!parent.exists) {
    if (name === '..') throw unresolvable('ENOENT', 'parent of a missing folder', path);
    return { path: candidate, exists: false };
  }
  let target: string;
  try {
    target = await readlink(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EINVAL') return { path: await realpathOrJs(candidate), exists: true };
    if (isMissingNameError(code, candidate, name)) return { path: candidate, exists: false };
    throw error;
  }
  // realpath cannot follow a dangling link, but a write will still follow it to create its target.
  if (++walk.hops > MAX_LINK_HOPS) throw unresolvable('ELOOP', 'too many symbolic links', path);
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
  const shellWrites = subject.shell?.writes;
  if (!paths && !shellPaths && !shellWrites) return subject;
  const spelled = async (list: readonly string[]): Promise<string[]> => [
    ...new Set([...list, ...(await Promise.all(list.map(physicalSpellings))).flat()]),
  ];
  return {
    ...subject,
    ...(paths ? { paths: await spelled(paths) } : {}),
    ...(subject.shell && (shellPaths || shellWrites)
      ? {
          shell: {
            ...subject.shell,
            ...(shellPaths ? { paths: await spelled(shellPaths) } : {}),
            ...(shellWrites ? { writes: await spelled(shellWrites) } : {}),
          },
        }
      : {}),
  };
}
