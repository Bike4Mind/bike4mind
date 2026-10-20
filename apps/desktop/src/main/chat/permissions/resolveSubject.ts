import { realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { PermissionSubject } from './rules';

async function physicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) {
      throw error;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await physicalPath(parent), basename(path));
  }
}

/** Check both the requested name and its target, including symlinked parents of new files. */
export async function resolveSubject(subject: PermissionSubject): Promise<PermissionSubject> {
  if (!subject.paths) return subject;
  const physical = await Promise.all(subject.paths.map(physicalPath));
  return { ...subject, paths: [...new Set([...subject.paths, ...physical])] };
}
