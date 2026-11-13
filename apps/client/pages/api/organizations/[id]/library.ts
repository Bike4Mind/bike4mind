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
  withTransaction,
} from '@bike4mind/database';
import { recordOrganizationAuditEvent } from '@bike4mind/server-utils/utils/organizationAudit';
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
      const organization = await assertLibraryAccess(req.user, organizationId);
      const items = await OrganizationLibrary.find({ organizationId: organization.id })
        .select('-definition')
        .sort({ pinned: -1, name: 1 });
      respond(res, libraryListResponse, { items });
    })
  )
  .post(
    csrfProtection(),
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const organizationId = z.string().parse(req.query.id);
      const item = await withTransaction(async () => {
        const organization = await assertLibraryAccess(req.user, organizationId, true);
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
          organizationId: organization.id,
          name: snapshot.definition.name,
          description: snapshot.definition.description ?? '',
          pinned: false,
        });
        await recordOrganizationAuditEvent({
          organizationId: organization.id,
          actorUserId: req.user.impersonatedBy ?? req.user.id,
          action: 'library.published',
          targetId: String(item._id),
        });
        return item;
      });
      respond(res, librarySummaryResponse, { item }, 201);
    })
  )
  .patch(
    csrfProtection(),
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const organizationId = z.string().parse(req.query.id);
      const item = await withTransaction(async () => {
        const organization = await assertLibraryAccess(req.user, organizationId, true);
        const { itemId, pinned } = pinSchema.parse(req.body);
        const filter = { _id: itemId, organizationId: organization.id };
        const existing = await OrganizationLibrary.findOne(filter).select('-definition');
        if (!existing) throw new NotFoundError('Library item not found');
        if (existing.pinned === pinned) return existing;
        const updated = await OrganizationLibrary.findOneAndUpdate(filter, { $set: { pinned } }, { new: true }).select(
          '-definition'
        );
        if (!updated) throw new NotFoundError('Library item not found');
        await recordOrganizationAuditEvent({
          organizationId: organization.id,
          actorUserId: req.user.impersonatedBy ?? req.user.id,
          action: pinned ? 'library.pinned' : 'library.unpinned',
          targetId: String(updated._id),
        });
        return updated;
      });
      respond(res, librarySummaryResponse, { item });
    })
  )
  .delete(
    csrfProtection(),
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const organizationId = z.string().parse(req.query.id);
      await withTransaction(async () => {
        const organization = await assertLibraryAccess(req.user, organizationId, true);
        const { itemId } = itemSchema.parse(req.body);
        const item = await OrganizationLibrary.findOneAndDelete({
          _id: itemId,
          organizationId: organization.id,
        }).select('_id');
        if (!item) throw new NotFoundError('Library item not found');
        await recordOrganizationAuditEvent({
          organizationId: organization.id,
          actorUserId: req.user.impersonatedBy ?? req.user.id,
          action: 'library.removed',
          targetId: String(item._id),
        });
      });
      res.status(204).end();
    })
  );

export default handler;
