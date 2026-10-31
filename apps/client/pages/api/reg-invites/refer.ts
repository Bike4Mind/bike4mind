import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { RegInviteEvents, escapeSlackLine, escapeSlackText, inboxAliasKey, requireEnv } from '@bike4mind/common';
import { IRegistrationInvite, RegInviteSource, RegInviteStatusType } from '@bike4mind/common';
import { registrationInviteRepository, User, userRepository } from '@bike4mind/database';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { createRegInvite, generateCode } from '@server/managers/regInviteManager';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { EmailEvents } from '@server/utils/eventBus';
import { getLogoUrl, buildEmailLogoImg } from '@bike4mind/server-utils/utils/mailer/emailHelpers';
import { postMessageToSlack } from '@bike4mind/server-utils/integrations/slack/slack';
import { Request } from 'express';
import { z } from 'zod';
import { escape } from 'html-escaper';

const CreateReferralRequestSchema = z.object({
  userName: z.string(),
  friendEmail: z.array(z.string().email()).min(1),
  emailTitle: z.string(),
  emailBody: z.string(),
  tags: z.array(z.string()).optional(),
});

// Attaches a rejection handler at creation. Deliveries start mid-loop while the loop keeps
// running, so an unobserved promise that rejects early would surface as an unhandled rejection.
const observeOperation = async (operation: Promise<unknown>): Promise<PromiseSettledResult<unknown>> => {
  const [outcome] = await Promise.allSettled([operation]);
  return outcome;
};

const handler = baseApi().post(
  outboundActionGate(),
  async (req: Request<unknown, unknown, z.infer<typeof CreateReferralRequestSchema>>, res) => {
    const newReferralData = CreateReferralRequestSchema.parse(req.body);
    const user = req.user;
    const { userName, emailTitle, emailBody } = newReferralData;
    // Dedup before reserveReferrals so a duplicated address is charged once.
    const friendEmail = Array.from(new Set(newReferralData.friendEmail.map(e => e.trim().toLowerCase())));
    const userId = user.id;

    // Minting credit-bearing invite codes requires proof the sender's own email
    // is real - otherwise a chain of unverified throwaway accounts could propagate
    // invites (each redeemed invite grants ReferralCreditsAmount). OTC sign-in marks
    // emailVerified; OAuth accounts carry a provider-verified email instead.
    const hasOAuthProvider = (user.authProviders?.length ?? 0) > 0;
    if (!user.emailVerified && !hasOAuthProvider) {
      throw new BadRequestError('Please verify your email address before sending referral invites');
    }

    // An alias of the sender's own inbox would let one person redeem their own invite for the
    // inviter reward. Refused before reserveReferrals so nothing is charged.
    // Emailless OAuth accounts have no inbox to alias.
    const senderInbox = user.email ? inboxAliasKey(user.email) : null;
    if (senderInbox && friendEmail.some(target => inboxAliasKey(target) === senderInbox)) {
      throw new BadRequestError('You cannot invite your own email address');
    }

    // Pre-resolve which targets already have an account, so the loop below can skip sending
    // to them. One `$in` query replaces the per-email `findOne` the loop used to do.
    //
    // Every submitted address counts against the quota, whether or not it turns out to be
    // sendable. This route used to charge only for genuine sends, which made it a bulk
    // account-existence oracle: probe a list for free, then read the answer off the response
    // (or off the referrals-remaining counter). Charging uniformly closes both channels -
    // the cost of a probe no longer depends on the answer. The trade is that referring
    // someone who already has an account now costs the sender a referral.
    const existingAccountEmails = new Set(
      (
        await User.find({ email: { $in: friendEmail } })
          .select('email')
          .lean<Array<{ email: string }>>()
      ).map(u => u.email)
    );

    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    // APP_URL is set per-deployment by infra; no brand fallback. (The prior
    // `APP_URL + '/register' || fallback` could never reach the fallback - string concat is
    // always truthy - so an unset APP_URL silently produced 'undefined/register'.)
    const defaultRegLink = `${requireEnv('APP_URL', process.env.APP_URL)}/register`;
    const registrationLink = settings.RegistrationLink || defaultRegLink;
    const brand = process.env.APP_NAME || '';
    const logoUrl = getLogoUrl();

    const notificationPromises: Promise<PromiseSettledResult<unknown>>[] = [];
    const emailPromises: { target: string; outcome: Promise<PromiseSettledResult<unknown>> }[] = [];
    const slackErrorMessages: string[] = [];

    // `sent` tracks genuine sends for the analytics counter; the caller instead sees
    // `accepted` below, which does not distinguish a send from a skip.
    const sent: string[] = [];
    const failed: string[] = [];
    const newInviteIds: string[] = [];

    if (!user.regInvites) {
      user.regInvites = [];
    }

    if (!(await userRepository.reserveReferrals(userId, friendEmail.length))) {
      throw new BadRequestError('Not enough referrals available');
    }

    let refundCount = 0;
    for (const target of friendEmail) {
      let hasUsableInvite = false;
      try {
        // Already-account emails were resolved up front.
        if (existingAccountEmails.has(target)) {
          // Reported to Slack only -- admin-side. The caller's response must not say which
          // addresses landed here (see `accepted` below).
          slackErrorMessages.push(`Email ${target} is already associated with an existing account. Skipping invite.`);
          continue;
        }

        let inviteCode: string;

        const invites = await registrationInviteRepository.find({ email: target });
        const now = new Date();
        const isLive = (invite: IRegistrationInvite) =>
          invite.status === RegInviteStatusType.open && !invite.used && (!invite.expiresAt || invite.expiresAt > now);
        const ownLive = invites.find(invite => invite.userId === userId && isLive(invite));
        const otherLive = invites.find(invite => invite.userId !== userId && isLive(invite));
        if (ownLive) {
          hasUsableInvite = true;
          inviteCode = ownLive.code;
        } else if (otherLive) {
          // Someone else already invited this address; reusing their code would credit them while
          // this sender is charged. Skipped silently like an existing account, so the response
          // does not reveal it and the reservation stays spent.
          slackErrorMessages.push(`Email ${target} already has an invite from another sender. Skipping invite.`);
          continue;
        } else {
          inviteCode = generateCode();
          const newRegInvite: IRegistrationInvite = {
            userId,
            email: target,
            code: inviteCode,
            status: RegInviteStatusType.open,
            source: RegInviteSource.referral,
          };
          const savedInvite = await createRegInvite(newRegInvite);
          hasUsableInvite = true;
          newInviteIds.push(savedInvite.id);
          user.regInvites.push(savedInvite.id);
        }

        const finalBody = `
            <!DOCTYPE html>
            <html>
            <head>
              <style>
                body {
                  font-family: Arial, sans-serif;
                  line-height: 1.5;
                  color: #333333;
                }
                .content {
                  margin: 20px;
                }
                .logo {
                  display: block;
                  margin-bottom: 20px;
                }
                a {
                  color: #1a82e2;
                }
              </style>
            </head>
            <body>
              <div class="content">
                ${buildEmailLogoImg(brand, logoUrl)}
                <p>${escape(emailBody)}</p>
                <p>Invite code: <strong>${escape(inviteCode)}</strong></p>
                <p><a href="${escape(registrationLink)}">Click here to register</a></p>
              </div>
            </body>
            </html>
          `;

        // Queue the Slack notification; sent in a batch after the loop.
        if (getSettingsValue('EnableReferralToSlack', settings)) {
          const slackMsg = `Referral sent by user ${escapeSlackLine(userName)}:${userId} to ${escapeSlackLine(target)} with ${inviteCode} and body ${escapeSlackText(finalBody)}`;
          notificationPromises.push(observeOperation(postMessageToSlack(slackMsg)));
        }

        // Queue the invite email; sent in a batch after the loop.
        if (getSettingsValue('EnableReferralToEmail', settings)) {
          emailPromises.push({
            target,
            outcome: observeOperation(
              EmailEvents.Send.publish({
                to: target,
                subject: emailTitle,
                body: finalBody,
              })
            ),
          });
        }

        sent.push(target);
      } catch (error) {
        const errorMessage = `Failed to process invite for ${target}: ${error instanceof Error ? error.message : error}`;
        console.error(errorMessage);
        slackErrorMessages.push(errorMessage);
        failed.push(target);
        if (!hasUsableInvite) refundCount++;
      }
    }

    // No app-level retry of settleReferrals: the refund is a non-idempotent $inc, so retrying after
    // an ambiguous failure (write applied, ack lost) would refund twice; retryWrites is off on DocumentDB.
    // Settle before deciding the outcome, then await every delivery that already started. A
    // settle failure is the only one that fails the request: the reservation has been charged
    // and the caller must know. A delivery failure does not - the invite exists and the charge
    // stands, so a 5xx would only invite a retry that charges the same addresses again.
    const settlement = await observeOperation(userRepository.settleReferrals(userId, refundCount, newInviteIds));
    const emailOutcomes = await Promise.all(emailPromises.map(delivery => delivery.outcome));
    await Promise.all(notificationPromises);

    // Log the repair payload before reporting deliveries: a settle failure still has to leave
    // behind which emails failed, and it is rethrown only after that report is out.
    if (settlement.status === 'rejected') {
      // The refund and invite ids never reached the user document; record them for repair.
      console.error('Referral settlement failed', {
        userId,
        refundCount,
        newInviteIds,
        error: settlement.reason,
      });
    }

    emailPromises.forEach((delivery, index) => {
      const outcome = emailOutcomes[index];
      if (outcome.status !== 'rejected') return;
      const reason: unknown = outcome.reason;
      const errorMessage = `Failed to deliver referral email to ${delivery.target}: ${
        reason instanceof Error ? reason.message : reason
      }`;
      console.error(errorMessage);
      slackErrorMessages.push(errorMessage);
      failed.push(delivery.target);
    });

    // Send accumulated error/skip messages to Slack as one batch.
    if (slackErrorMessages.length > 0) {
      const slackMessage = escapeSlackText(slackErrorMessages.join('\n'));
      await postMessageToSlack(slackMessage);
    }

    if (settlement.status === 'rejected') {
      throw settlement.reason;
    }

    // Everything that was not a hard processing failure is reported to the caller as sent,
    // in submission order so position cannot betray which addresses were skipped. The
    // reservation includes skips, keeping the remaining quota free of the same signal.
    const failedSet = new Set(failed);
    const accepted = friendEmail.filter(email => !failedSet.has(email));
    // `sent` gains a target before its delivery resolves, so a later email failure removes it.
    const delivered = sent.filter(email => !failedSet.has(email));

    await logEvent(
      {
        userId,
        type: RegInviteEvents.REFER_REGINVITE,
        counterValue: delivered.length,
        metadata: { ids: user.regInvites, referredEmails: delivered },
      },
      { ability: req.ability }
    );

    return res.status(201).json({
      message: 'Referral invites processed successfully',
      sent: accepted,
      failed,
    });
  }
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
