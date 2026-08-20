import { FeedbackModel, FeedbackTextModel, User } from '@bike4mind/database';
import {
  FeedbackEvents,
  FeedbackStatus,
  IOrganizationDocument,
  PromptMetaZodSchema,
  feedbackContentExpiresAt,
  redactFunctionCallsForViewer,
  truncateFeedbackContent,
} from '@bike4mind/common';
import type {
  FeedbackChannelDelivery,
  FeedbackDeliveryResult,
  FeedbackDeliveryStageClass,
  FeedbackDeliverySkipReason,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { logEvent } from '@server/utils/analyticsLog';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';
import { EmailEvents } from '@server/utils/eventBus';
import { postFeedbackToSlack } from '@server/integrations/slack/slack';
import { hydrateFeedbackText, toRedactedFeedback } from '@server/utils/redactedFeedback';
import { Config, classifyStage } from '@server/utils/config';
import { resolveFeedbackContext } from '@server/utils/feedbackContext';
import {
  recordFeedbackDeliverySuccess,
  recordFeedbackDeliveryFailure,
  recordFeedbackDeliverySkipped,
  ALARM_WORTHY_SKIP_REASONS,
} from '@server/utils/cloudwatch';
import mongoose from 'mongoose';
import sanitizeHtml from 'sanitize-html';
import { z } from 'zod';

const CreateFeedbackRequestSchema = z.object({
  userId: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  username: z.string(),
  userEmail: z.string(),
  type: z.string().optional(),
  promptMeta: PromptMetaZodSchema.optional(),
  // Untrusted pointers, not authorization keys - resolveFeedbackContext re-reads and
  // ownership-checks whichever of these (or their promptMeta fallback) is present before any of
  // it survives onto the saved document.
  questId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
});

// Trim each address and drop blanks so 'a@x.com, b@x.com' doesn't leave a leading space on every
// entry after the first, and a whitespace-only entry (',' or ' ') resolves to zero recipients.
function splitRecipients(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map(email => email.trim())
    .filter(Boolean);
}

type FeedbackEmailRoute =
  | { kind: 'send'; recipients: string[]; stageClass: FeedbackDeliveryStageClass }
  | { kind: 'skip'; stageClass: FeedbackDeliveryStageClass; reason: FeedbackDeliverySkipReason };

/**
 * Decides where feedback-to-email sends go for a given deploy stage, mirroring
 * resolveFeedbackSlackRoute (@server/integrations/slack/slack) so the two channels can't drift
 * apart on the same stage-leak bug. Non-production stages deliberately do NOT fall back to
 * FeedbackReceiveEmail - that fallback is exactly the leak this resolver closes (a real internal
 * recipient list otherwise inherited from a non-prod stage into the prod feedback inbox).
 */
export function resolveFeedbackEmailRoute(
  stage: string | undefined,
  settings: Record<string, string>
): FeedbackEmailRoute {
  const stageClass = classifyStage(stage);

  if (stageClass === 'production') {
    const recipients = splitRecipients(getSettingsValue('FeedbackReceiveEmail', settings));
    return recipients.length > 0
      ? { kind: 'send', recipients, stageClass }
      : { kind: 'skip', stageClass, reason: 'no_recipients' };
  }

  const recipients = splitRecipients(getSettingsValue('FeedbackReceiveEmailNonProd', settings));
  return recipients.length > 0
    ? { kind: 'send', recipients, stageClass }
    : { kind: 'skip', stageClass, reason: 'nonprod_unconfigured' };
}

const handler = baseApi()
  .get(async (req, res) => {
    if (!req.ability) {
      throw new Error('Ability not found');
    }

    if (!req.ability.can('read', FeedbackModel)) {
      throw new Error('Permission denied');
    }

    const feedback = await FeedbackModel.find();

    if (!feedback) {
      throw new NotFoundError('Feedback not found');
    }

    return res.json(await hydrateFeedbackText(feedback.map(toRedactedFeedback)));
  })
  .post(async (req, res) => {
    const newFeedbackData = CreateFeedbackRequestSchema.parse(req.body);
    const authenticated = req.isAuthenticated();
    if (authenticated) {
      console.log('Authenticated');
    }

    const { userId, content, tags, username, userEmail, promptMeta, type, questId, sessionId } = newFeedbackData;

    // The org lookup must key off the resolved identity too, not the raw body userEmail -- otherwise
    // two authenticated submissions from the same account can be stamped with different organizations
    // depending on whatever email string the client happened to send.
    const existingUser = authenticated
      ? await User.findById(req.user.id).populate('organizationId')
      : await User.findOne({ email: userEmail }).populate('organizationId');

    const organizationDoc = existingUser?.organizationId as unknown as IOrganizationDocument | undefined;
    const organization = organizationDoc?.name || 'Unknown';

    // Text-first (mirrors LakeAccessEventModel.record()): a FeedbackText write failure just
    // leaves contentStored false rather than failing the submission, but a Feedback save failure
    // after a successful text write must not leave an orphaned, unattributable text row behind.
    const feedbackId = new mongoose.Types.ObjectId();
    const writeFeedbackText = async (): Promise<boolean> => {
      if (content.trim().length === 0) return false;
      try {
        const { content: truncatedContent, contentTruncated } = truncateFeedbackContent(content);
        await FeedbackTextModel.create({
          _id: feedbackId,
          content: truncatedContent,
          contentTruncated,
          expiresAt: feedbackContentExpiresAt(new Date()),
        });
        return true;
      } catch (error) {
        req.logger.error('Failed to write FeedbackText sibling', error);
        return false;
      }
    };

    // organizationId/questId/sessionId become authorization keys for downstream scoped readers,
    // so they are derived server-side here rather than trusted from the request body - see
    // feedbackContext.ts for the full security rationale. `organization` above (the display
    // string) is unaffected: it keeps its existing email-fallback resolution regardless.
    // Independent of the text write above, so the two run concurrently.
    const [feedbackContext, contentStored] = await Promise.all([
      resolveFeedbackContext({
        authenticatedUserId: authenticated ? req.user.id : undefined,
        organizationId: organizationDoc?.id ?? null,
        claims: {
          questId: questId ?? promptMeta?.questId,
          sessionId: sessionId ?? promptMeta?.session?.id,
        },
        logger: req.logger,
      }),
      writeFeedbackText(),
    ]);

    const newFeedback = new FeedbackModel({
      _id: feedbackId,
      userId: req.isAuthenticated() ? req.user.id : userId,
      tags,
      status: FeedbackStatus.New,
      username: req.isAuthenticated() ? req.user.username : username,
      userEmail: req.isAuthenticated() ? req.user.email : userEmail,
      organization: organization,
      promptMeta: promptMeta,
      type,
      sessionId: feedbackContext.sessionId,
      questId: feedbackContext.questId,
      organizationId: feedbackContext.organizationId,
      subject: feedbackContext.subject,
      contentStored,
    });
    try {
      await newFeedback.save();
    } catch (error) {
      if (contentStored) {
        await FeedbackTextModel.deleteOne({ _id: feedbackId }).catch(() => undefined);
      }
      throw error;
    }

    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const stageClass = classifyStage(Config.STAGE);

    // A bug report leaves the product entirely (third-party Slack workspace, unencrypted email
    // to a static recipient list). functionCalls[].returnValue can hold verbatim tool output -
    // private corpus chunks, file contents - that the reporter never chose to disclose to those
    // destinations just by clicking "report a bug". Redact only for these two egress points; the
    // FeedbackModel record saved above keeps the full promptMeta, gated by the existing
    // admin-only read check on this same route.
    const promptMetaForExternalEgress = promptMeta
      ? { ...promptMeta, functionCalls: redactFunctionCallsForViewer(promptMeta.functionCalls) }
      : promptMeta;

    // Use the same resolved id already computed for the saved document, not the raw request-body
    // userId: an untrusted body value that isn't a valid ObjectId threw a Mongoose CastError deep
    // in the analytics side-effect, which errorHandler maps to a 404 -- masking a save that already
    // succeeded. The resolved id removes that specific trigger, but logEvent is still a post-save
    // side-effect that can fail for other reasons (e.g. a transient write failure inside
    // incrementUserCounter) -- same containment as the Slack/email side-effects below.
    if (authenticated) {
      try {
        // Never log the verbatim report text: CounterLog carries no TTL of its own, and doing so
        // would defeat the 90-day retention the FeedbackText split otherwise enforces.
        await logEvent(
          {
            userId: newFeedback.userId,
            type: FeedbackEvents.CREATE_FEEDBACK,
            metadata: { id: newFeedback.id },
          },
          { ability: req.ability }
        );
      } catch (error) {
        req.logger.error('Failed to log feedback analytics event', error);
      }
    }

    // Send feedback to Slack if enabled. postFeedbackToSlack records its own
    // success/failure/skip metrics and reports its own outcome; the 'disabled' skip is
    // recorded here since it never even calls into postFeedbackToSlack.
    let slack: FeedbackChannelDelivery;
    if (getSettingsValue('EnableFeedBackToSlack', settings)) {
      console.log('Sending feedback to Slack is enabled');
      slack = await postFeedbackToSlack(
        type || 'CS',
        organization,
        newFeedback.username,
        newFeedback.userEmail ?? '',
        newFeedback.userId,
        content,
        promptMetaForExternalEgress ? JSON.stringify(promptMetaForExternalEgress) : 'No prompt meta'
      );
    } else {
      slack = { outcome: 'skipped', reason: 'disabled' };
      await recordFeedbackDeliverySkipped('slack', stageClass, 'disabled', Config.STAGE);
    }

    let email: FeedbackChannelDelivery;
    const emailEnabled = getSettingsValue('EnableFeedBackToEmail', settings);
    const emailRoute = resolveFeedbackEmailRoute(Config.STAGE, settings);
    if (!emailEnabled) {
      email = { outcome: 'skipped', reason: 'disabled' };
      await recordFeedbackDeliverySkipped('email', emailRoute.stageClass, 'disabled', Config.STAGE);
    } else if (emailRoute.kind === 'skip') {
      email = { outcome: 'skipped', reason: emailRoute.reason };
      await recordFeedbackDeliverySkipped('email', emailRoute.stageClass, emailRoute.reason, Config.STAGE);
    } else {
      const feedbackEmails = emailRoute.recipients;
      console.log(`Sending feedback to all of these folks: ${feedbackEmails}`);
      console.log('Sending feedback to email is enabled');
      const sanitizedContent = sanitizeHtml(content);
      const sanitizedUsername = sanitizeHtml(newFeedback.username);
      const sanitizedUserEmail = sanitizeHtml(newFeedback.userEmail ?? '');
      const sanitizedType = type ? sanitizeHtml(type) : '';
      const sanitizedTags = tags ? tags.map(tag => sanitizeHtml(tag)) : [];
      const sanitizedPromptMeta = promptMetaForExternalEgress
        ? sanitizeHtml(JSON.stringify(promptMetaForExternalEgress, null, 2))
        : '';

      // allSettled (not all): one rejected recipient must not take down the whole handler
      // after Slack has already fired, and partial success/failure both need recording.
      const emailResults = await Promise.allSettled(
        feedbackEmails.map((recipientEmail: string) =>
          EmailEvents.Send.publish({
            to: recipientEmail,
            subject: 'New Feedback Received',
            body: `
              <!DOCTYPE html>
              <html lang="en" xmlns="http://www.w3.org/1999/xhtml">
              <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>New Feedback Submission</title>
                <style>
                  @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap');
                  body {
                    margin: 0;
                    padding: 0;
                    background-color: #f5f7fa;
                    font-family: 'Roboto', sans-serif;
                    color: #333;
                  }
                  .container {
                    width: 100%;
                    max-width: 600px;
                    margin: 30px auto;
                    background-color: #ffffff;
                    border-radius: 8px;
                    overflow: hidden;
                    box-shadow: 0 2px 5px rgba(0, 0, 0, 0.15);
                  }
                  .header {
                    background-color: #007bff;
                    color: #ffffff;
                    text-align: center;
                    padding: 30px 20px;
                  }
                  .header h1 {
                    margin: 0;
                    font-size: 28px;
                  }
                  .content {
                    padding: 30px 20px;
                  }
                  .content h2 {
                    font-size: 22px;
                    margin-bottom: 20px;
                  }
                  .content p {
                    font-size: 16px;
                    line-height: 1.6;
                    margin-bottom: 15px;
                  }
                  .info {
                    background-color: #f1f1f1;
                    padding: 20px;
                    border-radius: 5px;
                    margin-bottom: 20px;
                  }
                  .info p {
                    margin: 5px 0;
                  }
                  .tags {
                    margin-top: 10px;
                  }
                  .tag {
                    display: inline-block;
                    background: #28a745;
                    color: #fff;
                    padding: 5px 10px;
                    border-radius: 15px;
                    font-size: 12px;
                    margin: 5px 5px 0 0;
                  }
                  .footer {
                    text-align: center;
                    padding: 20px;
                    background-color: #e9ecef;
                    font-size: 14px;
                    color: #6c757d;
                  }
                  @media (max-width: 600px) {
                    .content h2 {
                      font-size: 20px;
                    }
                    .header h1 {
                      font-size: 24px;
                    }
                  }
                </style>
              </head>
              <body>
                <div class="container">
                  <div class="header">
                    <h1>You've Got Feedback from ${sanitizedUsername}</h1>
                  </div>
                  <div class="content">
                    <h2>New Feedback Submission</h2>
                    <div class="info">
                      <p><strong>From:</strong> ${sanitizedUsername} (ID: ${newFeedback.userId})</p>
                      <p><strong>Email:</strong> ${sanitizedUserEmail}</p>
                      ${sanitizedType ? `<p><strong>Type:</strong> ${sanitizedType}</p>` : ''}
                    </div>
                    <p><strong>Message:</strong></p>
                    <p>${sanitizedContent}</p>
                    ${
                      sanitizedTags.length
                        ? `<div class="tags">
                            <strong>Tags:</strong>
                            ${sanitizedTags.map(tag => `<span class="tag">${tag}</span>`).join('')}
                          </div>`
                        : ''
                    }
                    ${
                      promptMeta
                        ? `<div class="info">
                            <p><strong>Prompt Meta:</strong></p>
                            <pre style="white-space: pre-wrap; word-wrap: break-word;">${sanitizedPromptMeta}</pre>
                          </div>`
                        : ''
                    }
                  </div>
                  <div class="footer">
                    <p>This is an automated email from [Your Company]. Please do not reply directly to this message.</p>
                  </div>
                </div>
              </body>
              </html>
              `,
          })
        )
      );
      const succeeded = emailResults.filter(r => r.status === 'fulfilled').length;
      // emailResults is index-aligned with feedbackEmails (allSettled preserves order), which is
      // what lets a rejection be tied back to the recipient it actually failed for.
      const rejected = emailResults
        .map((result, i) => ({ result, email: feedbackEmails[i] }))
        .filter((r): r is { result: PromiseRejectedResult; email: string } => r.result.status === 'rejected');
      await Promise.all([
        succeeded > 0 ? recordFeedbackDeliverySuccess('email', stageClass) : undefined,
        succeeded < emailResults.length
          ? recordFeedbackDeliveryFailure('email', stageClass, 'publish_error', Config.STAGE)
          : undefined,
      ]);
      // A partial failure still trips the alarm-worthy metric above, but the channel-level
      // outcome below reports 'delivered' (some recipients did get it), so isIncident() never
      // sees it - log the actual rejection reasons here, the one place that still has them
      // (an all-fail send also lands here rather than only in the generic isIncident log below,
      // which never reads emailResults[i].reason).
      if (rejected.length > 0) {
        Logger.error('[feedback] email publish rejected for one or more recipients', {
          feedbackId: newFeedback.id,
          succeeded,
          attempted: emailResults.length,
          failedRecipients: rejected.map(r => r.email),
          reasons: rejected.map(r => String(r.result.reason)),
        });
      }
      // 'email delivered' means the outbound-mail event was attempted (EmailEvents.Send.publish
      // resolved), not that it was actually enqueued or sent - the underlying PutEvents call can
      // return success with a rejected entry that nothing in this repo currently checks for, and
      // SMTP delivery itself happens in a separate, uninstrumented subsystem.
      email = succeeded > 0 ? { outcome: 'delivered' } : { outcome: 'failed', reason: 'error' };
    }

    const delivery: FeedbackDeliveryResult = {
      delivered: slack.outcome === 'delivered' || email.outcome === 'delivered',
      channels: { slack, email },
    };
    // Reuse the alarm's own taxonomy so log severity can't drift from alarm severity: a
    // deliberately-silent skip (both channels disabled, or a non-prod stage with no webhook
    // configured) is expected and logs at most a warning, while a hard failure or an
    // enabled-but-actually-broken skip is the incident the alarm pages on.
    const isIncident = (c: FeedbackChannelDelivery): boolean =>
      c.outcome === 'failed' || (c.outcome === 'skipped' && ALARM_WORTHY_SKIP_REASONS.some(r => r === c.reason));
    if ([slack, email].some(isIncident)) {
      Logger.error('[feedback] delivery failed for a submitted feedback record', {
        feedbackId: newFeedback.id,
        delivery,
      });
    } else if (!delivery.delivered) {
      Logger.warn('[feedback] no delivery path configured', { feedbackId: newFeedback.id, delivery });
    }

    // newFeedback.toJSON() (not a spread of the hydrated doc) - the schema sets
    // toJSON: { virtuals: true }, which is what produces `id`; spreading the doc directly
    // yields Mongoose's internal _doc/$__ fields instead. `content` is echoed from the request
    // variable, not read off the saved doc, since it now lives on the FeedbackText sibling.
    return res.status(201).json({ ...newFeedback.toJSON(), content, delivery });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
