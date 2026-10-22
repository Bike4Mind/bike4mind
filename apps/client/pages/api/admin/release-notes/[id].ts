import { z } from 'zod';
import { releaseNoteRepository } from '@bike4mind/database';
import {
  ApiKeyScope,
  createModalStillImageSchema,
  createModalVideoSchema,
  findDenied,
  ReleaseNoteItemSchema,
  scrubCustomerText,
} from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { deploymentMediaOrigins } from '@server/utils/deploymentMediaOrigins';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { BadRequestError, ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import {
  loadDenylistOrThrow,
  noteOrThrow,
  toAdminReleaseNote,
} from '@bike4mind/server-utils/releaseNotes/adminReleaseNotes';
import { canAdministerReleaseNotes, isReleaseNotesWriteOnlyKey } from '@server/releaseNotes/releaseNotesWriteOnlyKey';

const EditSchema = z
  .object({
    headline: z.string().min(1).optional(),
    summary: z.string().optional(),
    items: z.array(ReleaseNoteItemSchema).optional(),
    video: createModalVideoSchema({ extraOrigins: deploymentMediaOrigins() }).nullable().optional(),
    image: createModalStillImageSchema({ extraOrigins: deploymentMediaOrigins() }).nullable().optional(),
  })
  .strict()
  .refine(edit => Object.values(edit).some(value => value !== undefined), { message: 'Nothing to update' });

const api = baseApi({ requiredScopes: [ApiKeyScope.ADMIN, ApiKeyScope.RELEASE_NOTES_WRITE] });

const handler = api.patch(async (req, res) => {
  // The job key holds release-notes:write and no admin scope, so apiKeyAuth withholds the owner's admin
  // role on req.user; the narrow form that key gets is enforced below.
  if (!canAdministerReleaseNotes(req)) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const { id } = req.query;
  if (!isValidObjectId(id)) throw new BadRequestError('Invalid release note id');

  const parsed = EditSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  }
  // release-notes:write may only set the video or the image, and that write is the job's, not an admin edit:
  // attachVideo/attachImage leave editedAt alone so the note is not marked edited and still regenerates.
  if (isReleaseNotesWriteOnlyKey(req)) {
    const other = Object.entries(parsed.data)
      .filter(([field, value]) => field !== 'video' && field !== 'image' && value !== undefined)
      .map(([field]) => field);
    if (other.length > 0) {
      throw new ForbiddenError(
        `${ApiKeyScope.RELEASE_NOTES_WRITE} may only set video or image, not ${other.join(', ')}`
      );
    }
    const { video, image } = parsed.data;
    if (video !== undefined && image !== undefined) throw new BadRequestError('video, image: send one per request');
    if (image !== undefined) {
      return res.json(toAdminReleaseNote(noteOrThrow(await releaseNoteRepository.attachImage(id, image))));
    }
    if (video === undefined) throw new BadRequestError('video or image: required');
    return res.json(toAdminReleaseNote(noteOrThrow(await releaseNoteRepository.attachVideo(id, video))));
  }

  // Same scrub and denylist the generator applies (workers releaseNotes/finalize.ts), so an edit cannot
  // put a PR ref or a denylisted name in front of customers.
  const denylist = await loadDenylistOrThrow(req.logger);
  const clean = (field: string, value: string, allowEmpty = false): string => {
    const text = scrubCustomerText(value);
    if (!text && !allowEmpty) throw new BadRequestError(`${field} is empty after removing internal references`);
    const term = findDenied(text, denylist);
    if (term) throw new BadRequestError(`${field} must not mention "${term}"`);
    return text;
  };

  const { headline, summary, items, video, image } = parsed.data;
  const result = await releaseNoteRepository.edit(id, {
    ...(headline !== undefined && { headline: clean('headline', headline) }),
    ...(summary !== undefined && { summary: clean('summary', summary, true) }),
    ...(video !== undefined && { video }),
    ...(image !== undefined && { image }),
    ...(items !== undefined && {
      items: items.map((item, i) => ({ ...item, text: clean(`items.${i}.text`, item.text) })),
    }),
  });
  const note = noteOrThrow(result);
  await recordAdminActionFromRequest(req, {
    action: 'settings.release_note.updated',
    target: { kind: 'settings', id, displayName: `release note ${note.releaseTag}` },
    summary: `edited release note ${note.releaseTag}`,
    details: { releaseTag: note.releaseTag, fields: Object.keys(parsed.data) },
  });
  return res.json(toAdminReleaseNote(note));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
