import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { parseSkillMd } from '@bike4mind/common/utils/skillMd';
import { SKILL_FILE_DIRS, SKILL_FILE_LIMITS, checkSkillFiles, type ISkillFile } from '@bike4mind/common';
import type { SkillUploadPreview } from '@shared/skillMarket';

/** Well above the server's 50,000-character body plus frontmatter; refused before parsing. */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;
const SKILL_MD = 'SKILL.md';
const EXTRA_FILES_SHOWN = 5;

/**
 * Read a skill for upload: a SKILL.md, a skill folder (its SKILL.md), or any .md command file.
 * Callers pass only a catalog entry's path or the native picker's pick. Never rejects.
 */
export async function readSkillSource(path: string): Promise<SkillUploadPreview> {
  try {
    const picked = await stat(path);
    const file = picked.isDirectory() ? join(path, SKILL_MD) : path;
    const info = file === path ? picked : await stat(file).catch(() => null);
    if (!info?.isFile()) return { ok: false, error: `No ${SKILL_MD} in that folder.` };
    if (info.size > MAX_SKILL_FILE_BYTES)
      return { ok: false, error: 'That file is too large for a skill (over 256 KB).' };

    const parsed = parseSkillMd(await readFile(file, 'utf8'));
    if (!parsed.ok) return parsed;

    // Only a SKILL.md owns its folder; a commands/foo.md sits among unrelated sibling commands.
    const isSkillMd = basename(file) === SKILL_MD;
    const files: ISkillFile[] = [];
    const others: string[] = [];
    if (isSkillMd) {
      const read = await readSupportingFiles(dirname(file), '', files, others);
      if (read) return read;
      const checked = checkSkillFiles(files);
      if (!checked.ok) return { ok: false, error: checked.error };
      files.splice(0, files.length, ...checked.files);
      others.sort();
    }
    const { name, description, body, argumentHint, claudeCodeAllowedTools, disableModelInvocation } = parsed.fields;
    return {
      ok: true,
      fields: {
        name: (name ?? (isSkillMd ? basename(dirname(file)) : basename(file, extname(file)))).trim().toLowerCase(),
        description: description ?? '',
        body: body ?? '',
        ...(argumentHint !== undefined ? { argumentHint } : {}),
        ...(claudeCodeAllowedTools !== undefined ? { claudeCodeAllowedTools } : {}),
        ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
        ...(files.length ? { files } : {}),
      },
      dropped: parsed.dropped,
      ...(parsed.source ? { source: parsed.source } : {}),
      extraFiles: others.slice(0, EXTRA_FILES_SHOWN),
      extraFileCount: others.length,
    };
  } catch {
    return { ok: false, error: 'That file could not be read.' };
  }
}

/**
 * Walks a skill folder: text files under scripts/ and references/ go to `files`; everything else
 * (other top-level entries, symlinks) goes to `others`. Dotfiles are skipped. Returns an error preview
 * for a binary or oversized file, which must not be silently left out of what gets reviewed.
 */
async function readSupportingFiles(
  root: string,
  prefix: string,
  files: ISkillFile[],
  others: string[]
): Promise<SkillUploadPreview | null> {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name.startsWith('.') || path === SKILL_MD) continue;
    const inSupportedDir = (SKILL_FILE_DIRS as readonly string[]).includes(path.split('/')[0]);
    if (!inSupportedDir || entry.isSymbolicLink()) {
      others.push(path);
    } else if (entry.isDirectory()) {
      const failed = await readSupportingFiles(root, path, files, others);
      if (failed) return failed;
    } else if (entry.isFile()) {
      if ((await stat(join(root, path))).size > SKILL_FILE_LIMITS.maxFileBytes) {
        return { ok: false, error: `${path}: files must be ${SKILL_FILE_LIMITS.maxFileBytes / 1024} KB or smaller` };
      }
      try {
        files.push({
          path,
          content: new TextDecoder('utf-8', { fatal: true }).decode(await readFile(join(root, path))),
        });
      } catch {
        return { ok: false, error: `${path}: only text files are supported` };
      }
    }
  }
  return null;
}
