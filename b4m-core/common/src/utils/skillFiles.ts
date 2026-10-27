import type { ISkillFile } from '../types/entities/SkillMarketTypes';

/**
 * Supporting files a skill ships beside its SKILL.md. Shared by the server (apps/client
 * server/utils/skillValidation.ts), the web folder import and the desktop skill reader, so all three
 * accept exactly the same set. Sizes are UTF-8 bytes. Stored inline on the Skill and on each listing
 * version, so the total stays far below Mongo's 16 MB document cap.
 */
export const SKILL_FILE_LIMITS = {
  maxFiles: 20,
  maxFileBytes: 100 * 1024,
  maxTotalBytes: 512 * 1024,
  maxPathLength: 200,
} as const;

export const SKILL_FILE_DIRS = ['scripts', 'references'] as const;

const SEGMENT_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export const skillFileBytes = (content: string): number => new TextEncoder().encode(content).length;

/** Why `path` is not a valid supporting-file path, or null when it is. */
export function skillFilePathError(path: string): string | null {
  if (path.length > SKILL_FILE_LIMITS.maxPathLength) {
    return `${path.slice(0, 40)}...: paths must be ${SKILL_FILE_LIMITS.maxPathLength} characters or fewer`;
  }
  const segments = path.split('/');
  if (segments.length < 2 || !(SKILL_FILE_DIRS as readonly string[]).includes(segments[0])) {
    return `${path}: files must be inside scripts/ or references/`;
  }
  // The pattern also rules out `.`, `..`, dotfiles, empty segments (a leading or doubled `/`) and backslashes.
  if (!segments.every(s => SEGMENT_PATTERN.test(s))) {
    return `${path}: path segments may use only letters, digits, '.', '_' and '-', and may not start with '.'`;
  }
  return null;
}

/** The one path ordering every hash, snapshot and zip uses; keep them on this so the sha stays stable. */
export const compareSkillFilePaths = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export type SkillFilesCheck = { ok: true; files: ISkillFile[] } | { ok: false; error: string };

/** Validates a skill's supporting files; on success returns them sorted by path (the order every hash and zip uses). */
export function checkSkillFiles(files: ISkillFile[]): SkillFilesCheck {
  if (files.length > SKILL_FILE_LIMITS.maxFiles) {
    return { ok: false, error: `A skill can have at most ${SKILL_FILE_LIMITS.maxFiles} supporting files` };
  }
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (typeof file?.path !== 'string' || typeof file.content !== 'string') {
      return { ok: false, error: 'Each supporting file needs a string path and content' };
    }
    const pathError = skillFilePathError(file.path);
    if (pathError) return { ok: false, error: pathError };
    // Case-insensitive so the zip cannot hold two entries that collide on macOS/Windows file systems.
    const key = file.path.toLowerCase();
    if (seen.has(key)) return { ok: false, error: `${file.path}: duplicate file` };
    seen.add(key);
    if (file.content.includes('\u0000')) return { ok: false, error: `${file.path}: only text files are supported` };
    const bytes = skillFileBytes(file.content);
    if (bytes > SKILL_FILE_LIMITS.maxFileBytes) {
      return { ok: false, error: `${file.path}: files must be ${SKILL_FILE_LIMITS.maxFileBytes / 1024} KB or smaller` };
    }
    total += bytes;
  }
  if (total > SKILL_FILE_LIMITS.maxTotalBytes) {
    return {
      ok: false,
      error: `Supporting files must total ${SKILL_FILE_LIMITS.maxTotalBytes / 1024} KB or less`,
    };
  }
  const sorted = files.map(({ path, content }) => ({ path, content })).sort(compareSkillFilePaths);
  // A path that is also a directory prefix of another cannot be extracted from the zip.
  const lowered = new Set(sorted.map(f => f.path.toLowerCase()));
  for (const path of lowered) {
    for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
      if (lowered.has(path.slice(0, i))) {
        return { ok: false, error: `${path.slice(0, i)}: cannot be both a file and a folder` };
      }
    }
  }
  return { ok: true, files: sorted };
}
