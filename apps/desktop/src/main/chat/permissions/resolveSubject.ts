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
    // realpath cannot follow a dangling link, but a write will still follow it to create its target.
    try {
      const target = await readlink(path);
      return physicalPath(isAbsolute(target) ? target : `${dirname(path)}${sep}${target}`);
    } catch (linkError) {
      // After ENOENT a link name can no longer sit past PATH_MAX, so a too-long readlink means missing.
      if (!(
        linkError instanceof Error &&
        'code' in linkError &&
        (linkError.code === 'EINVAL' ||
          (absent && linkError.code === 'ENAMETOOLONG') ||
          isMissingPathError(linkError.code, path))
      ))
        throw linkError;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await physicalPath(parent), basename(path));
  }
}

/** Check both the requested name and its target, including symlinked parents of new files. */
export async function resolveSubject(subject: PermissionSubject): Promise<PermissionSubject> {
  const paths = subject.paths;
  const shellPaths = subject.shell?.paths;
  if (!paths && !shellPaths) return subject;
  const resolved = await Promise.all((paths ?? []).map(physicalPath));
  const resolvedShell = await Promise.all((shellPaths ?? []).map(physicalPath));
  return {
    ...subject,
    ...(paths ? { paths: [...new Set([...paths, ...resolved])] } : {}),
    ...(subject.shell && shellPaths
      ? { shell: { ...subject.shell, paths: [...new Set([...shellPaths, ...resolvedShell])] } }
      : {}),
  };
}
