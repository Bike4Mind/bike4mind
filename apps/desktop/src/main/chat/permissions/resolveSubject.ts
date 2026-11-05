import { realpathSync } from 'node:fs';
import { readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { isMissingPathError } from '../tools/paths';
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
  try {
    return await realpathOrJs(path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && isMissingPathError(error.code, path))) throw error;
    const absent = error.code === 'ENOENT' || error.code === 'ENOTDIR';
    let tooLong = false;
    // realpath cannot follow a dangling link, but a write will still follow it to create its target.
    try {
      const target = await readlink(path);
      return physicalPath(isAbsolute(target) ? target : `${dirname(path)}${sep}${target}`);
    } catch (linkError) {
      tooLong = absent && (linkError as NodeJS.ErrnoException).code === 'ENAMETOOLONG';
      if (!(
        linkError instanceof Error &&
        'code' in linkError &&
        (linkError.code === 'EINVAL' || tooLong || isMissingPathError(linkError.code, path))
      ))
        throw linkError;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    const resolved = join(await physicalPath(parent), basename(path));
    if (!tooLong) return resolved;
    // readlink cannot read a name past PATH_MAX: a shorter physical spelling may expose a link there.
    if (resolved !== path) return physicalPath(resolved);
    const parentExists = await realpathOrJs(parent).then(
      () => true,
      () => false
    );
    if (parentExists) throw error;
    return resolved;
  }
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
