import { readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import type { PermissionSubject } from './rules';

/**
 * Codes meaning no file by this name exists. ENAMETOOLONG is one: a shell operand such as a
 * multi-line `git commit -m` message is checked like a path, and no file can carry that name.
 */
const MISSING = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG']);

export async function physicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && MISSING.has(String(error.code)))) throw error;
    // realpath cannot follow a dangling link, but a write will still follow it to create its target.
    try {
      const target = await readlink(path);
      return physicalPath(isAbsolute(target) ? target : `${dirname(path)}${sep}${target}`);
    } catch (linkError) {
      if (!(
        linkError instanceof Error &&
        'code' in linkError &&
        (linkError.code === 'EINVAL' || MISSING.has(String(linkError.code)))
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
