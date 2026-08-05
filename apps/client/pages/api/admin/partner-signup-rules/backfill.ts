import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError, ensureAdmin } from '@server/utils/errors';
import { NotFoundError } from '@bike4mind/utils';
import { partnerSignupRuleRepository, userRepository, organizationRepository } from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';
import { assertOrganizationExists } from '@server/entitlements/assertOrganizationExists';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { auditSeatCeilingRaised } from '@server/organizations/notifySeatCeilingRaised';
import { postMessageToSlack } from '@server/integrations/slack/slack';
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

    // Since a commit can now grow the seat ceiling (#1239), the preview surfaces the seat/billing
    // blast radius, not just the head count. A Stripe-billed org keeps its ceiling (candidates past
    // it are rejected, not billed silently); a non-Stripe org raises to fit the whole backfill.
    const currentSeats = organization?.seats ?? 0;
    const currentMembers = organization?.users?.length ?? 0;
    const stripeBilled = !!organization?.stripeCustomerId;
    const projectedSeats = stripeBilled ? currentSeats : Math.max(currentSeats, currentMembers + candidates.length);

    if (!body.commit) {
      return res.status(200).json({
        dryRun: true,
        organizationId: rule.organizationId,
        domain: rule.domain,
        matched: candidates.length,
        seats: currentSeats,
        projectedSeats,
        stripeBilled,
        sample: candidates.slice(0, SAMPLE_LIMIT).map(u => ({ id: u.id, email: u.email, name: u.name })),
      });
    }

    // `seatRaised` counts adds that also lifted the org's seat ceiling (#1239): a full non-Stripe org
    // raises to fit rather than rejecting; a full Stripe-billed org keeps its ceiling and the candidate
    // is counted in `atCapacity`. Each raise still writes a durable ORG_SEAT_CEILING_RAISED audit event
    // (actor = the admin running the backfill); the per-candidate Slack ping is skipped for a deliberate
    // bulk action, replaced by one summary post after the loop.
    const actingAdminId = req.user?.id;
    const tally = { added: 0, seatRaised: 0, atCapacity: 0, alreadyMember: 0, unverified: 0, failed: 0 };
    for (const candidate of candidates) {
      try {
        const result = await organizationService.applyPartnerRuleMembership(
          { userId: candidate.id, organizationId: rule.organizationId },
          { db: { users: userRepository, organizations: organizationRepository }, logger: req.logger }
        );
        if (result.added) {
          tally.added += 1;
          if (result.reason === 'added-seat-raised') {
            tally.seatRaised += 1;
            await auditSeatCeilingRaised(
              {
                organizationId: rule.organizationId,
                userId: candidate.id,
                previousSeats: result.previousSeats,
                newSeats: result.newSeats,
                trigger: 'admin-backfill',
                actingAdminId,
              },
              req.logger
            );
          }
        } else if (result.reason === 'at-capacity') tally.atCapacity += 1;
        else if (result.reason === 'already-member') tally.alreadyMember += 1;
        else tally.unverified += 1; // 'unverified' | 'org-missing' | 'user-missing' - candidate was verified, so effectively a skip
      } catch (error) {
        tally.failed += 1;
        req.logger.error(
          `Partner-rule backfill failed for user ${candidate.id} into org ${rule.organizationId}`,
          error
        );
      }
    }

    if (tally.seatRaised > 0) {
      // One LiveOps summary for the whole bulk raise (per-candidate Slack is intentionally skipped).
      await postMessageToSlack(
        `🎟️ *Org seat ceiling auto-raised (admin backfill)*\n` +
          `*Organization:* ${rule.organizationId}\n` +
          `*Ceiling grown by:* ${tally.seatRaised} seat${tally.seatRaised === 1 ? '' : 's'}\n` +
          `*Domain:* ${rule.domain}\n` +
          `*Run by admin:* ${actingAdminId ?? 'unknown'}`
      ).catch(err =>
        req.logger.error(`Partner-rule backfill seat-raise summary alert failed for org ${rule.organizationId}`, err)
      );
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
