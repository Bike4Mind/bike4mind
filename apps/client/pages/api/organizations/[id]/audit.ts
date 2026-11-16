import { OrganizationAuditEventModel, organizationRepository } from '@bike4mind/database/infra';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import {
  canReadOrganizationAudit,
  organizationAuditCsv,
  organizationAuditFilter,
  organizationAuditQuerySchema,
} from '@bike4mind/server-utils/utils/organizationAuditRead';

const handler = baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler(async (req, res) => {
    const query = organizationAuditQuerySchema.parse(req.query);
    const org = await organizationRepository.findById(query.id);
    if (!org) throw new NotFoundError('Organization not found');
    if (!canReadOrganizationAudit(req.user, org)) throw new ForbiddenError('Organization audit access denied');
    if (query.format === 'csv' && (!query.from || !query.to)) {
      throw new BadRequestError('CSV export requires a date range');
    }
    const filter = organizationAuditFilter(query);
    const limit = query.format === 'csv' ? 10000 : 50;
    // ObjectId order gives stable, bounded pagination without offset scans.
    const events = await OrganizationAuditEventModel.find({
      ...filter,
      ...(query.before && query.format !== 'csv' ? { _id: { $lt: query.before } } : {}),
    })
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();
    res.setHeader('Cache-Control', 'private, no-store');
    if (query.format === 'csv') {
      if (events.length > limit) throw new BadRequestError('Too many events; choose a smaller date range');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="organization-audit.csv"');
      return res.send(organizationAuditCsv(events));
    }
    const page = events.slice(0, limit);
    return res.json({
      events: page.map(event => ({
        id: String(event._id),
        occurredAt: event.occurredAt,
        actorUserId: event.actorUserId,
        action: event.action,
        targetId: event.targetId,
      })),
      nextCursor: events.length > limit ? String(page[page.length - 1]._id) : null,
    });
  })
);

export const config = { api: { externalResolver: true } };
export default handler;
