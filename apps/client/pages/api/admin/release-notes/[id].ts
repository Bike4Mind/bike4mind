import { z } from 'zod';
import { releaseNoteRepository } from '@bike4mind/database';
import { ApiKeyScope, findDenied, ReleaseNoteItemSchema, scrubCustomerText } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { isValidObjectId } from '@server/utils/objectId';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { loadReleaseNotesConfig, noteOrThrow, toAdminReleaseNote } from '@server/releaseNotes/adminReleaseNotes';

const EditSchema = z
  .object({
    headline: z.string().min(1).optional(),
    summary: z.string().optional(),
    items: z.array(ReleaseNoteItemSchema).optional(),
  })
  .strict()
  .refine(edit => Object.values(edit).some(value => value !== undefined), { message: 'Nothing to update' });

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).patch(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const { id } = req.query;
  if (!isValidObjectId(id)) throw new BadRequestError('Invalid release note id');

  const parsed = EditSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  }

  // Same scrub and denylist the generator applies (workers releaseNotes/finalize.ts), so an edit cannot
  // put a PR ref or a denylisted name in front of customers.
  const { config: notesConfig } = await loadReleaseNotesConfig(req.logger);
  const denylist = notesConfig.denylist.map(term => term.trim().toLowerCase()).filter(Boolean);
  const clean = (field: string, value: string, allowEmpty = false): string => {
    const text = scrubCustomerText(value);
    if (!text && !allowEmpty) throw new BadRequestError(`${field} is empty after removing internal references`);
    const term = findDenied(text, denylist);
    if (term) throw new BadRequestError(`${field} must not mention "${term}"`);
    return text;
  };

  const { headline, summary, items } = parsed.data;
  const result = await releaseNoteRepository.edit(id, {
    ...(headline !== undefined && { headline: clean('headline', headline) }),
    ...(summary !== undefined && { summary: clean('summary', summary, true) }),
    ...(items !== undefined && {
      items: items.map((item, i) => ({ ...item, text: clean(`items.${i}.text`, item.text) })),
    }),
  });
  return res.json(toAdminReleaseNote(noteOrThrow(result)));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
