import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { parseSkillMd } from '@bike4mind/common';
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
    const others = isSkillMd
      ? (await readdir(dirname(file))).filter(name => name !== SKILL_MD && !name.startsWith('.')).sort()
      : [];
    const { name, description, body, argumentHint, disableModelInvocation } = parsed.fields;
    return {
      ok: true,
      fields: {
        name: (name ?? (isSkillMd ? basename(dirname(file)) : basename(file, extname(file)))).trim().toLowerCase(),
        description: description ?? '',
        body: body ?? '',
        ...(argumentHint !== undefined ? { argumentHint } : {}),
        ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
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
