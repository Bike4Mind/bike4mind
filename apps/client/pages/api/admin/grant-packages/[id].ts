import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { NotFoundError } from '@bike4mind/utils';
import { grantPackageRepository, withTransaction } from '@bike4mind/database';
import { ApiKeyScope, updateGrantPackageSchema, updateRequiresGrantReason, type AuditChange } from '@bike4mind/common';
import { loadCreditGrantPolicy, parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { splitReason, toBadRequest } from '@server/credits/grantPackageAdmin';
import { z } from 'zod';

const handler = adminApi({
  adminPermissions: { PATCH: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).patch(
  asyncHandler(async (req, res) => {
    const { id } = req.query as { id?: string };
    if (!id) throw new BadRequestError('Package id required');

    const { rawReason, fields } = splitReason(req.body);
    let data: z.infer<typeof updateGrantPackageSchema>;
    try {
      data = updateGrantPackageSchema.parse(fields);
    } catch (error) {
      toBadRequest(error);
    }

    const stored = await grantPackageRepository.findById(id);
    if (!stored) throw new NotFoundError('Grant package not found');
    // Judged on the package as it will be after the edit, so a removed cap or raised amount counts.
    // Not atomic with the write: two concurrent admin edits are each judged against the pre-edit package.
    const after = { ...stored, ...data };
    const reasonRequired = updateRequiresGrantReason(stored, after, await loadCreditGrantPolicy());
    const reason = reasonRequired ? parseAdminActionReason(rawReason) : undefined;

    const changedFields = (Object.keys(data) as (keyof typeof data)[]).filter(
      field => JSON.stringify(stored[field] ?? null) !== JSON.stringify(data[field] ?? null)
    );

    const updated = await withTransaction(async () => {
      const pkg = await grantPackageRepository.update(id, reason ? { ...data, reason } : data);
      if (!pkg) throw new NotFoundError('Grant package not found');
      const changes: AuditChange[] = changedFields.map(field => ({
        field,
        before: stored[field] ?? null,
        after: pkg[field] ?? null,
      }));
      await recordAdminActionFromRequest(req, {
        action: 'credits.grant_package.updated',
        target: { kind: 'settings', id: pkg.id, displayName: pkg.name },
        summary: `updated grant package ${pkg.name}`,
        reason,
        changes,
        details: { reasonRequired },
      });
      return pkg;
    });

    res.status(200).json(updated);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
