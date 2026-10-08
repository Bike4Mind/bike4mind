import {
  adminSettingsRepository,
  type IReleaseNoteDocument,
  type ReleaseNoteAdminStatus,
  type ReleaseNoteMutationResult,
} from '@bike4mind/database';
import {
  parseReleaseNotesConfig,
  ReleaseNotesConfigSchema,
  type ReleaseNoteItem,
  type ReleaseNotesConfig,
} from '@bike4mind/common';
import { getSettingsByNames } from '@bike4mind/utils';
import type { Logger } from '@bike4mind/observability';
import { BadRequestError, ConflictError, NotFoundError } from '@server/utils/errors';

export const RELEASE_NOTES_SETTING = 'releaseNotesConfig';

export interface AdminReleaseNote {
  id: string;
  releaseTag: string;
  headline: string;
  summary: string;
  items: ReleaseNoteItem[];
  state: ReleaseNoteAdminStatus;
  publishAt: string;
  deployedAt: string;
  deployedSha: string;
  editedAt: string | null;
}

export const toAdminReleaseNote = (note: IReleaseNoteDocument, now = new Date()): AdminReleaseNote => ({
  id: note.id,
  releaseTag: note.releaseTag,
  headline: note.headline,
  summary: note.summary,
  items: note.items.map(({ category, text, importance, sourcePrs }) => ({ category, text, importance, sourcePrs })),
  state: note.status === 'hidden' ? 'hidden' : note.publishAt <= now ? 'published' : 'scheduled',
  publishAt: note.publishAt.toISOString(),
  deployedAt: note.deployedAt.toISOString(),
  deployedSha: note.deployedSha,
  editedAt: note.editedAt ? note.editedAt.toISOString() : null,
});

export function noteOrThrow(result: ReleaseNoteMutationResult): IReleaseNoteDocument {
  if (result.kind === 'notFound') throw new NotFoundError('Release note not found');
  if (result.kind === 'emptyItems') throw new BadRequestError('A release note with no items cannot go live');
  return result.note;
}

/** The stored config, or the defaults with `malformed: true` when the stored value does not parse. */
export async function loadReleaseNotesConfig(
  logger: Logger
): Promise<{ config: ReleaseNotesConfig; malformed: boolean }> {
  const settings = await getSettingsByNames(
    [RELEASE_NOTES_SETTING],
    { adminSettings: adminSettingsRepository },
    { logger }
  );
  const parsed = parseReleaseNotesConfig(settings[RELEASE_NOTES_SETTING]);
  if (parsed.success) return { config: parsed.data, malformed: false };
  logger.warn(`[admin/release-notes] ${RELEASE_NOTES_SETTING} is malformed`, { issues: parsed.error.issues });
  return { config: ReleaseNotesConfigSchema.parse({}), malformed: true };
}

/**
 * The current denylist for a route that is about to put text in front of customers. Refuses with 409
 * while the stored config is malformed, since its defaults carry an empty denylist that would pass anything.
 */
export async function loadDenylistOrThrow(logger: Logger): Promise<string[]> {
  const { config, malformed } = await loadReleaseNotesConfig(logger);
  if (malformed) {
    throw new ConflictError('Release notes settings are malformed; save them in admin settings first');
  }
  return config.denylist.map(term => term.trim().toLowerCase()).filter(Boolean);
}
