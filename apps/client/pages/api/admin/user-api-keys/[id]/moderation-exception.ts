import { z } from 'zod';
import {
  BadRequestError,
  MODERATION_EXCEPTION_CATEGORIES,
  type IUserApiKeyModerationException,
} from '@bike4mind/common';
import { withTransaction } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import {
  assertCanActOnKeyOwner,
  auditKeyRef,
  loadApiKeyOrThrow,
  ownerAuditTarget,
  readApiKeyIdParam,
} from '@server/utils/adminApiKeyActions';

const CategoriesSchema = z
  .array(z.enum(MODERATION_EXCEPTION_CATEGORIES))
  .max(MODERATION_EXCEPTION_CATEGORIES.length)
  .refine(categories => new Set(categories).size === categories.length, 'Categories must not repeat');

/**
 * PUT /api/admin/user-api-keys/[id]/moderation-exception  { categories, reason }
 *
 * Requires users:moderate: sets which prompt moderation categories one key is excepted from, or
 * clears the exception with an empty `categories`. Only MODERATION_EXCEPTION_CATEGORIES are
 * accepted. The processor reads the key on every flagged turn, so the change applies to the next
 * one. The write and its strict audit row commit together.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { PUT: 'users:moderate' } })
  .use(csrfProtection())
  .put(async (req, res) => {
    const keyId = readApiKeyIdParam(req);
    const reason = parseAdminActionReason(req.body?.reason);
    const parsed = CategoriesSchema.safeParse(req.body?.categories);
    if (!parsed.success) {
      throw new BadRequestError(`categories must be a list drawn from: ${MODERATION_EXCEPTION_CATEGORIES.join(', ')}`);
    }

    const key = await loadApiKeyOrThrow(keyId);
    await assertCanActOnKeyOwner(req.user, key.userId, 'change the moderation exception of API keys of');

    const exception: IUserApiKeyModerationException | null =
      parsed.data.length > 0 ? { categories: parsed.data, reason, setBy: req.user.id, setAt: new Date() } : null;

    const target = await ownerAuditTarget(key.userId);
    await withTransaction(async () => {
      // Re-read on transaction retry so the audit names the state this write actually replaces.
      const before = (await userApiKeyRepository.findModerationException(key.id))?.moderationException.categories ?? [];
      await userApiKeyRepository.setModerationException(key.id, exception);
      await recordAdminActionFromRequest(req, {
        action: 'user.api_key.moderation_exception_updated',
        target,
        summary: exception
          ? `set the moderation exception of API key ${key.keyPrefix} to ${exception.categories.join(', ')}`
          : `cleared the moderation exception of API key ${key.keyPrefix}`,
        reason,
        changes: [{ field: 'moderationException.categories', before, after: exception?.categories ?? [] }],
        details: { ...auditKeyRef(key), keyName: key.name },
      });
    });

    return res.status(200).json({ keyId: key.id, moderationException: exception });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
