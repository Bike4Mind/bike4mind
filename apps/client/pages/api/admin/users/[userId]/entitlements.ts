import { userRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@server/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { subscriptionRepository } from '@server/models/Subscription';
import { SUBSCRIPTION_PLANS_MAP } from '@client/lib/userSubscriptions/constants';
import {
  DOMAIN_GRANTS,
  PRICE_ENTITLEMENTS,
  TAG_GRANTS,
  allKnownEntitlementKeys,
  grantTagForEntitlement,
  isBypassExemptEntitlement,
  normalizeTag,
} from '@client/lib/entitlements/registry';
import { partnerEntitlementsForEmail } from '@server/entitlements/partnerRules';
import { hasDeveloperUserTag } from '@bike4mind/common';
import type { EntitlementKey } from '@client/lib/entitlements/types';

type EntitlementSourceType = 'tag' | 'domain' | 'subscription' | 'admin-bypass' | 'developer-bypass';

interface EntitlementSource {
  type: EntitlementSourceType;
  detail: string;
}

interface EntitlementRow {
  key: EntitlementKey;
  held: boolean;
  /** The comp tag that grants this key via the admin panel's tag toggle, if one exists. */
  grantTag?: string;
  sources: EntitlementSource[];
}

/**
 * Admin-only "why does this user have (or lack) product access" resolver -
 * the fix for phantom-access visibility (b4m-optihashi-compute-gate cutover
 * dependency; admin-roles-product-access-redesign M2+M4). Unlike
 * `getUserEntitlements` (which returns only the held key set for gating),
 * this walks EVERY known product key and records every contributing source
 * -tag / domain / subscription / admin bypass / developer-tag bypass - so an
 * admin can see and revoke a phantom grant instead of guessing at it. The two
 * bypass sources are suppressed for bypass-exempt keys (see
 * `isBypassExemptEntitlement`), whose enforcement honors neither bypass, so the
 * report matches the gate for them. Note this reports on the VIEWED user; a
 * feature gated on a different principal (e.g. an org-billed embed key resolves
 * the org billing owner) matches only when that principal is the viewed user.
 */
const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { userId } = req.query as { userId: string };
    if (typeof userId !== 'string') {
      throw new BadRequestError('Invalid user ID');
    }

    const user = await userRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    const tags = user.tags ?? [];
    const emailVerified = user.emailVerified === true;
    const emailDomain = (() => {
      if (!emailVerified || !user.email) return null;
      const at = user.email.lastIndexOf('@');
      if (at < 0) return null;
      return normalizeTag(user.email.slice(at + 1));
    })();

    const [activeSubscriptions, partnerKeys] = await Promise.all([
      subscriptionRepository.findActiveUserSubscriptions(userId),
      partnerEntitlementsForEmail(user.email, user.emailVerified),
    ]);

    const isDeveloper = hasDeveloperUserTag(tags);

    const rows: EntitlementRow[] = allKnownEntitlementKeys().map(key => {
      const sources: EntitlementSource[] = [];

      for (const tag of tags) {
        const normalizedTag = normalizeTag(tag);
        if (normalizedTag === key || TAG_GRANTS.get(normalizedTag)?.includes(key)) {
          sources.push({ type: 'tag', detail: tag });
        }
      }

      if (emailDomain && DOMAIN_GRANTS.get(emailDomain)?.includes(key)) {
        sources.push({ type: 'domain', detail: emailDomain });
      }
      if (partnerKeys.has(key)) {
        sources.push({ type: 'domain', detail: `${emailDomain ?? 'unknown domain'} (partner rule)` });
      }

      for (const subscription of activeSubscriptions) {
        if (PRICE_ENTITLEMENTS.get(subscription.priceId)?.includes(key)) {
          const planName = SUBSCRIPTION_PLANS_MAP[subscription.priceId]?.name ?? subscription.priceId;
          sources.push({ type: 'subscription', detail: planName });
        }
      }

      // Bypass-exempt keys (e.g. embed white-label) are enforced against the
      // owner's literal grant and honor NEITHER bypass - reporting a bypass
      // source for them would claim access the gate won't confer. Suppress both
      // so held/sources match `getUserEntitlements` (the enforcement resolver).
      if (!isBypassExemptEntitlement(key)) {
        if (user.isAdmin) {
          sources.push({ type: 'admin-bypass', detail: 'Super Admin' });
        }
        if (isDeveloper) {
          sources.push({ type: 'developer-bypass', detail: 'Developer tag' });
        }
      }

      return {
        key,
        held: sources.length > 0,
        grantTag: grantTagForEntitlement(key),
        sources,
      };
    });

    return res.status(200).json({ entitlements: rows });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
