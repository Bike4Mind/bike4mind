import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { grantPackageRepository, withTransaction } from '@bike4mind/database';
import { ApiKeyScope, createGrantPackageSchema, requiresGrantReason } from '@bike4mind/common';
import { loadCreditGrantPolicy, parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { splitReason, toBadRequest } from '@server/credits/grantPackageAdmin';
import { z } from 'zod';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const handler = adminApi({
  adminPermissions: { GET: 'support:read', POST: 'settings:manage' },
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .get(
    asyncHandler(async (req, res) => {
      let query: z.infer<typeof listQuerySchema>;
      try {
        query = listQuerySchema.parse(req.query);
      } catch (error) {
        toBadRequest(error);
      }
      const [result, policy] = await Promise.all([grantPackageRepository.listPackages(query), loadCreditGrantPolicy()]);
      // The form mirrors the server's reason rule, so it needs the live thresholds.
      res.status(200).json({
        ...result,
        reasonPolicy: { singleGrantCredits: policy.singleGrantCredits, dailyTotalCredits: policy.dailyTotalCredits },
      });
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const { rawReason, fields } = splitReason(req.body);
      let data: z.infer<typeof createGrantPackageSchema>;
      try {
        data = createGrantPackageSchema.parse(fields);
      } catch (error) {
        toBadRequest(error);
      }
      const reasonRequired = requiresGrantReason(data, await loadCreditGrantPolicy());
      const reason = reasonRequired ? parseAdminActionReason(rawReason) : undefined;

      const created = await withTransaction(async () => {
        const pkg = await grantPackageRepository.create({ ...data, createdBy: req.user.id, reason: reason ?? null });
        await recordAdminActionFromRequest(req, {
          action: 'credits.grant_package.created',
          target: { kind: 'settings', id: pkg.id, displayName: pkg.name },
          summary: `created grant package ${pkg.name}`,
          reason,
          details: {
            name: pkg.name,
            packageCredits: pkg.credits,
            storageMb: pkg.storageMb ?? null,
            totalCap: pkg.totalCap,
            dailyCap: pkg.dailyCap,
            active: pkg.active,
            reasonRequired,
          },
        });
        return pkg;
      });

      res.status(201).json(created);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
