import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError, ensureAdmin } from '@server/utils/errors';
import { NotFoundError } from '@bike4mind/utils';
import { partnerSignupRuleRepository, userRepository, organizationRepository } from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';
import { assertOrganizationExists } from '@server/entitlements/assertOrganizationExists';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { z } from 'zod';

/**
 * Backfill existing verified users on a rule's domain into its associated organization.
 *
 * Dry-run by default (`commit: false`): returns the count + a sample of who WOULD be added,
 * so the admin previews the blast radius before committing - a bulk membership mutation is
 * not a one-click action. `commit: true` runs the same resolution and adds each candidate via
 * the shared `applyPartnerRuleMembership` (idempotent, seat-aware, additive). Re-runnable.
 */
const backfillSchema = z.object({
  id: z.string().min(1),
  commit: z.boolean().default(false),
});

const SAMPLE_LIMIT = 25;

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);

    let body: z.infer<typeof backfillSchema>;
    try {
      body = backfillSchema.parse(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new BadRequestError(error.issues.map(e => `${e.path.join('.') || 'value'}: ${e.message}`).join('; '));
      }
      throw error;
    }

    const rule = await partnerSignupRuleRepository.findById(body.id);
    if (!rule) throw new NotFoundError('Partner signup rule not found');
    if (!rule.organizationId) {
      throw new BadRequestError('This rule has no associated organization to backfill into');
    }
    await assertOrganizationExists(rule.organizationId);

    // Verified users whose email ends in @<domain>. Anchored + escaped so `partner.com`
    // can't match `notpartner.com` or a `partner.com.evil.co` substring.
    const domainPattern = `@${escapeRegex(rule.domain)}$`;
    const domainUsers = await userRepository.find({
      email: { $regex: domainPattern, $options: 'i' },
      emailVerified: true,
    });

    // Membership truth is the org's users[] ACL. Anyone already there is skipped up front so
    // the preview count reflects only real additions.
    const organization = await organizationRepository.findById(rule.organizationId);
    const memberIds = new Set((organization?.users ?? []).map(u => u.userId));
    const candidates = domainUsers.filter(u => !memberIds.has(u.id));

    if (!body.commit) {
      return res.status(200).json({
        dryRun: true,
        organizationId: rule.organizationId,
        domain: rule.domain,
        matched: candidates.length,
        sample: candidates.slice(0, SAMPLE_LIMIT).map(u => ({ id: u.id, email: u.email, name: u.name })),
      });
    }

    // `seatRaised` counts adds that also lifted the org's seat ceiling (#1239): a full org no longer
    // rejects a domain candidate, it raises to fit. It's a subset of `added`, surfaced separately so
    // the admin sees how much the backfill grew the seat count. The admin already sees this tally, so
    // the per-signup Slack alert is intentionally NOT fired for a deliberate bulk backfill.
    const tally = { added: 0, seatRaised: 0, alreadyMember: 0, unverified: 0, failed: 0 };
    for (const candidate of candidates) {
      try {
        const result = await organizationService.applyPartnerRuleMembership(
          { userId: candidate.id, organizationId: rule.organizationId },
          { db: { users: userRepository, organizations: organizationRepository }, logger: req.logger }
        );
        if (result.added) {
          tally.added += 1;
          if (result.reason === 'added-seat-raised') tally.seatRaised += 1;
        } else if (result.reason === 'already-member') tally.alreadyMember += 1;
        else tally.unverified += 1; // 'unverified' | 'org-missing' | 'user-missing' - candidate was verified, so effectively a skip
      } catch (error) {
        tally.failed += 1;
        req.logger.error(
          `Partner-rule backfill failed for user ${candidate.id} into org ${rule.organizationId}`,
          error
        );
      }
    }

    return res.status(200).json({
      dryRun: false,
      organizationId: rule.organizationId,
      domain: rule.domain,
      matched: candidates.length,
      ...tally,
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
