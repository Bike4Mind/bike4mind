import { RegInviteEvents, requireEnv } from '@bike4mind/common';
import { IRegistrationInvite, RegInviteStatusType } from '@bike4mind/common';
import { registrationInviteRepository, User, userRepository } from '@bike4mind/database';
import { logEvent } from '@server/utils/analyticsLog';
import { createRegInvite, generateCode } from '@server/managers/regInviteManager';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError } from '@server/utils/errors';
import { EmailEvents } from '@server/utils/eventBus';
import { getLogoUrl, buildEmailLogoImg } from '@server/utils/mailer/emailHelpers';
import { postMessageToSlack } from '@server/integrations/slack/slack';
import { Request } from 'express';
import { z } from 'zod';
import { escape } from 'html-escaper';

const CreateReferralRequestSchema = z.object({
  userName: z.string(),
  friendEmail: z.array(z.string()),
  emailTitle: z.string(),
  emailBody: z.string(),
  tags: z.array(z.string()).optional(),
});

const handler = baseApi().post(
  async (req: Request<unknown, unknown, z.infer<typeof CreateReferralRequestSchema>>, res) => {
    const newReferralData = CreateReferralRequestSchema.parse(req.body);
    const user = req.user;
    const { userName, friendEmail, emailTitle, emailBody } = newReferralData;
    const userId = user.id;

    // Minting credit-bearing invite codes requires proof the sender's own email
    // is real - otherwise a chain of unverified throwaway accounts could propagate
    // invites (each redeemed invite grants ReferralCreditsAmount). OTC sign-in marks
    // emailVerified; OAuth accounts carry a provider-verified email instead.
    const hasOAuthProvider = (user.authProviders?.length ?? 0) > 0;
    if (!user.emailVerified && !hasOAuthProvider) {
      throw new BadRequestError('Please verify your email address before sending referral invites');
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
    if (user.numReferralsAvailable < friendEmail.length) {
      throw new BadRequestError('Not enough referrals available');
    }

    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    // APP_URL is set per-deployment by infra; no brand fallback. (The prior
    // `APP_URL + '/register' || fallback` could never reach the fallback - string concat is
    // always truthy - so an unset APP_URL silently produced 'undefined/register'.)
    const defaultRegLink = `${requireEnv('APP_URL', process.env.APP_URL)}/register`;
    const registrationLink = settings.RegistrationLink || defaultRegLink;
    const brand = process.env.APP_NAME || '';
    const logoUrl = getLogoUrl();

    const notificationPromises: Promise<unknown>[] = [];
    const emailPromises: Promise<unknown>[] = [];
    const slackErrorMessages: string[] = [];

    // `sent` tracks genuine sends for the analytics counter; the caller instead sees
    // `accepted` below, which does not distinguish a send from a skip.
    const sent: string[] = [];
    const failed: string[] = [];

    if (!user.regInvites) {
      user.regInvites = [];
    }

    for (const target of friendEmail) {
      try {
        // Already-account emails were resolved up front (drives the sendable guard above).
        if (existingAccountEmails.has(target)) {
          // Reported to Slack only -- admin-side. The caller's response must not say which
          // addresses landed here (see `accepted` below).
          slackErrorMessages.push(`Email ${target} is already associated with an existing account. Skipping invite.`);
          continue;
        }

        let inviteCode: string;

        const existingInvite = await registrationInviteRepository.findOne({ email: target });
        if (!existingInvite) {
          inviteCode = generateCode();
          const newRegInvite: IRegistrationInvite = {
            userId,
            email: target,
            code: inviteCode,
            status: RegInviteStatusType.open,
          };
          const savedInvite = await createRegInvite(newRegInvite);
          try {
            user.regInvites.push(savedInvite.id);
          } catch (error) {
            console.error(`Failed to add invite ID to user's regInvites for ${target}: ${error}`);
          }
        } else {
          inviteCode = existingInvite.code;
        }

        // Passwordless registration has no invite-code field, so the email links to
        // the bare /register page - no `?code=` (dead copy the form can't consume).
        // The invite record + code are still minted for referral tracking below.
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
                <p><a href="${escape(registrationLink)}">Click here to register</a></p>
              </div>
            </body>
            </html>
          `;

        // Queue the Slack notification; sent in a batch after the loop.
        if (getSettingsValue('EnableReferralToSlack', settings)) {
          const slackMsg = `Referral sent by user ${userName}:${userId} to ${target} with ${inviteCode} and body ${finalBody}`;
          notificationPromises.push(postMessageToSlack(slackMsg));
        }

        // Queue the invite email; sent in a batch after the loop.
        if (getSettingsValue('EnableReferralToEmail', settings)) {
          console.log(emailBody, 'QQQ: Sending email to', target, `with body ${finalBody}`);
          emailPromises.push(
            EmailEvents.Send.publish({
              to: target,
              subject: emailTitle,
              body: finalBody,
            })
          );
        }

        sent.push(target);
      } catch (error) {
        const errorMessage = `Failed to process invite for ${target}: ${error instanceof Error ? error.message : error}`;
        console.error(errorMessage);
        slackErrorMessages.push(errorMessage);
        failed.push(target);
      }
    }

    await Promise.all(notificationPromises);
    await Promise.all(emailPromises);

    // Send accumulated error/skip messages to Slack as one batch.
    if (slackErrorMessages.length > 0) {
      const slackMessage = slackErrorMessages.join('\n');
      await postMessageToSlack(slackMessage);
    }

    // Everything that was not a hard processing failure is reported to the caller as sent,
    // in submission order so position cannot betray which addresses were skipped. The
    // decrement matches, keeping the referrals-remaining counter free of the same signal.
    const failedSet = new Set(failed);
    const accepted = friendEmail.filter(email => !failedSet.has(email));

    user.numReferralsAvailable = Math.max(0, user.numReferralsAvailable - accepted.length);
    await userRepository.update(user);
    await logEvent(
      {
        userId,
        type: RegInviteEvents.REFER_REGINVITE,
        counterValue: sent.length,
        metadata: { ids: user.regInvites, referredEmails: sent },
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
