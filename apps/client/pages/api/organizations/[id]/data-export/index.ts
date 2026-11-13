import { randomUUID } from 'crypto';
import { cacheRepository } from '@bike4mind/database';
import { OrganizationAuditEventModel } from '@bike4mind/database/infra';
import { TooManyRequestsError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { sendToQueue } from '@bike4mind/server-utils/utils/sqs';
import { recordOrganizationAuditEvent } from '@bike4mind/server-utils/utils/organizationAudit';
import {
  organizationExportQuery,
  requireOrganizationExportOwner,
} from '@bike4mind/server-utils/utils/organizationDataExport';

const handler = baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .get(async (req, res) => {
    const { id } = organizationExportQuery.parse(req.query);
    await requireOrganizationExportOwner(req.user, id);
    const latest = await OrganizationAuditEventModel.findOne({
      organizationId: id,
      actorUserId: req.user.id,
      action: 'export.requested',
    })
      .sort({ _id: -1 })
      .lean();
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ exportJobId: latest?.targetId ?? null });
  })
  .post(async (req, res) => {
    const { id } = organizationExportQuery.parse(req.query);
    await requireOrganizationExportOwner(req.user, id);
    const key = `rate-limit:organization-export:${id}`;
    const quota = await cacheRepository.tryIncrementWithinLimitFixedWindow(key, 1, 3600000);
    if (!quota.success) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((quota.expiresAt.getTime() - Date.now()) / 1000)));
      throw new TooManyRequestsError('An organization export can be requested once per hour');
    }
    const exportJobId = randomUUID();
    const audit = { organizationId: id, actorUserId: req.user.id, targetId: exportJobId };
    try {
      await recordOrganizationAuditEvent({ ...audit, action: 'export.requested' });
      await sendToQueue(getSourceQueueUrl('accountDataExportQueue'), {
        kind: 'organization',
        id,
        userId: req.user.id,
        exportJobId,
      });
    } catch (error) {
      await cacheRepository.releaseFromFixedWindow(key, 1, quota.expiresAt);
      await recordOrganizationAuditEvent({ ...audit, action: 'export.failed' });
      throw error;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(202).json({ exportJobId });
  });

export default handler;
