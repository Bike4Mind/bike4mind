import { SUBSCRIBER_SOURCES, TURNSTILE_ACTION_SUBSCRIBE } from '@bike4mind/common';
import { Subscriber } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { baseApi } from '@server/middlewares/baseApi';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import { requireTurnstile } from '@server/middlewares/requireTurnstile';
import { postMessageToSlack } from '@server/integrations/slack/slack';
import { ipSubject, otcLimitOf } from '@server/utils/otcLimits';
import { SUBSCRIBER_LIMITS, reserveSubscriberAlert } from '@server/utils/subscriberLimits';
import * as z from 'zod';

// One body for every outcome. It also stops an anonymous caller receiving the stored
// Subscriber document, which the 201 used to return in full.
const SIGNUP_ACK = { message: 'Thanks -- you are on the list.' } as const;

const MONGO_DUPLICATE_KEY = 11000;

/**
 * Caller-supplied text for a Slack code span. Slack still parses `<...>` control sequences there, so
 * `&`, `<` and `>` are entity-escaped; the span itself stops mentions and bare links from rendering.
 * A backtick would close the span early and a newline would break it, so both are replaced.
 */
function slackCodeText(value: string): string {
  const text = value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return `\`${text}\``;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === MONGO_DUPLICATE_KEY;
}

const { perIp, perIpDaily } = SUBSCRIBER_LIMITS;

// Every accepted signup stores a row and pages the team on Slack, and nothing proves who is asking,
// so the source is bounded the same way as a sign-in code request: a bot challenge first, then
// per-IP caps keyed like OTC_LIMITS (IPv6 by /64). Both caps are admin-lowerable (see subscriberLimits.ts).
const handler = baseApi({ auth: false })
  .use(checkBlockedIP())
  .use(requireTurnstile(TURNSTILE_ACTION_SUBSCRIBE))
  .use(
    rateLimit({
      bucket: 'subscribers-create-short',
      subject: ipSubject,
      limit: () => otcLimitOf(perIp),
      windowMs: perIp.windowMs,
    })
  )
  .use(
    rateLimit({
      bucket: 'subscribers-create-daily',
      subject: ipSubject,
      limit: () => otcLimitOf(perIpDaily),
      windowMs: perIpDaily.windowMs,
    })
  )
  .post(async (req, res) => {
    const validatedBody = z
      .object({
        firstName: z.string().trim().min(1).max(50),
        lastName: z.string().trim().min(1).max(50),
        email: z.string().trim().toLowerCase().email(),
        source: z.enum(SUBSCRIBER_SOURCES).default('subscribe_page'),
      })
      .parse(req.body);

    // This route is unauthenticated, so a 400 'Email already registered' vs a 201 let anyone
    // test whether an address is on the waitlist. Both outcomes now return SIGNUP_ACK: a repeat
    // signup is a no-op that looks exactly like a first one. The Slack alert below is skipped
    // for a duplicate so admins are not paged twice for the same address.
    const existingSubscriber = await Subscriber.findOne({ email: validatedBody.email, deletedAt: null });
    if (existingSubscriber) {
      return res.status(201).json(SIGNUP_ACK);
    }

    try {
      await Subscriber.create(validatedBody);
    } catch (error) {
      // email is unique across soft-deleted rows too, and two concurrent signups can race the check
      // above. Either way the address is already stored; a 500 here would reveal that.
      if (isDuplicateKeyError(error)) return res.status(201).json(SIGNUP_ACK);
      throw error;
    }

    try {
      const alert = await reserveSubscriberAlert();
      if (alert.action === 'pause') {
        await postMessageToSlack(
          `New subscriber alerts are paused until ${alert.resumesAt.toISOString()} because of volume. ` +
            'New signups are still saved; see *Admin Panel > Subscribers*.'
        );
      } else if (alert.action === 'post') {
        const brand = process.env.APP_NAME || '';
        const blockedSignupNote =
          validatedBody.source === 'subscribe_page'
            ? ''
            : `\nThey tried to sign up while registration was closed (source: \`${validatedBody.source}\`).\n`;
        const name = slackCodeText(`${validatedBody.firstName} ${validatedBody.lastName}`);
        const slackMessage = `\u{1F3AF} *New Subscriber Alert!*

\u{1F4E7} ${name} (${slackCodeText(validatedBody.email)}) just requested an invite code!
${blockedSignupNote}
\u{1F44B} They're waiting at the door and ready to join${brand ? ` ${brand}` : ''}. Time to roll out the red carpet!

\u{1F39F}\u{FE0F} An admin can generate their invite code with custom credits and storage in the admin panel.

\u{1F4CD} *Admin Panel > Subscribers* to convert them to a user.`;

        await postMessageToSlack(slackMessage);
      }
    } catch (slackError) {
      // Don't fail the request if the Slack notification fails
      console.error('Failed to send Slack notification for new subscriber:', slackError);
    }

    return res.status(201).json(SIGNUP_ACK);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
