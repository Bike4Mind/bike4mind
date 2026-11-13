import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import {
  agentRepository,
  skillRepository,
  briefcasePromptRepository,
  imageGenerationTemplateRepository,
  OrganizationLibrary,
} from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { assertLibraryAccess } from '@server/organizations/libraryAccess';
import { respond } from '@server/utils/respond';
import {
  libraryListResponse,
  librarySummaryResponse,
  librarySourcesResponse,
} from '@server/organizations/libraryResponse';
import {
  agentLibraryDefinition,
  skillLibraryDefinition,
  promptLibraryDefinition,
  templateLibraryDefinition,
} from '@server/organizations/libraryDefinition';

const publishSchema = z.object({
  kind: z.enum(['agent', 'skill', 'prompt', 'template']),
  sourceId: z.string().regex(/^[a-f\d]{24}$/i),
});
const itemSchema = z.object({ itemId: z.string().regex(/^[a-f\d]{24}$/i) });
const pinSchema = itemSchema.extend({ pinned: z.boolean() });

const handler = baseApi({ auth: 'jwtOnly' })
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string; sources?: string }>(async (req, res) => {
      const organizationId = z.string().parse(req.query.id);
      if (req.query.sources) {
        await assertLibraryAccess(req.user, organizationId, true);
        const kind = publishSchema.shape.kind.parse(req.query.sources);
        const sources =
          kind === 'agent'
            ? (
                await agentRepository.searchAccessible(
                  req.user.id,
                  '',
                  { query: { userId: req.user.id, type: { $ne: 'voice' } } },
                  { page: 1, limit: 100 },
                  { by: 'updatedAt', direction: 'desc' }
                )
              ).data
            : kind === 'skill'
              ? await skillRepository.listForUser(req.user.id)
              : kind === 'prompt'
                ? await briefcasePromptRepository.listPersonal(req.user.id)
                : await imageGenerationTemplateRepository.listOwned(req.user.id, 100);
        respond(res, librarySourcesResponse, { sources });
        return;
      }
      await assertLibraryAccess(req.user, organizationId);
      const items = await OrganizationLibrary.find({ organizationId })
        .select('-definition')
        .sort({ pinned: -1, name: 1 });
      respond(res, libraryListResponse, { items });
    })
  )
  .post(
    csrfProtection(),
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const organizationId = z.string().parse(req.query.id);
      await assertLibraryAccess(req.user, organizationId, true);
      const { kind, sourceId } = publishSchema.parse(req.body);
      const owned = <T extends { userId?: string | null }>(source: T | null): T => {
        if (!source || source.userId !== req.user.id) throw new NotFoundError('Owned source not found');
        return source;
      };
      const snapshot =
        kind === 'agent'
          ? agentLibraryDefinition(owned(await agentRepository.findById(sourceId)))
          : kind === 'skill'
            ? skillLibraryDefinition(owned(await skillRepository.findById(sourceId)))
            : kind === 'prompt'
              ? promptLibraryDefinition(owned(await briefcasePromptRepository.findById(sourceId)))
              : templateLibraryDefinition(owned(await imageGenerationTemplateRepository.findById(sourceId)));
      if (!snapshot.definition.name) throw new BadRequestError('Source must have a name');
      const item = await OrganizationLibrary.create({
        ...snapshot,
        organizationId,
        name: snapshot.definition.name,
        description: snapshot.definition.description ?? '',
        pinned: false,
      });
      respond(res, librarySummaryResponse, { item }, 201);
    })
  )
  .patch(
    csrfProtection(),
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const organizationId = z.string().parse(req.query.id);
      await assertLibraryAccess(req.user, organizationId, true);
      const { itemId, pinned } = pinSchema.parse(req.body);
      const item = await OrganizationLibrary.findOneAndUpdate(
        { _id: itemId, organizationId },
        { $set: { pinned } },
        { new: true }
      ).select('-definition');
      if (!item) throw new NotFoundError('Library item not found');
      respond(res, librarySummaryResponse, { item });
    })
  )
  .delete(
    csrfProtection(),
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const organizationId = z.string().parse(req.query.id);
      await assertLibraryAccess(req.user, organizationId, true);
      const { itemId } = itemSchema.parse(req.body);
      const result = await OrganizationLibrary.deleteOne({ _id: itemId, organizationId });
      if (!result.deletedCount) throw new NotFoundError('Library item not found');
      res.status(204).end();
    })
  );

export default handler;
