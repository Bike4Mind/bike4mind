import { Subscriber } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { postMessageToSlack } from '@server/integrations/slack/slack';
import * as z from 'zod';

// One body for every outcome. It also stops an anonymous caller receiving the stored
// Subscriber document, which the 201 used to return in full.
const SIGNUP_ACK = { message: 'Thanks -- you are on the list.' } as const;

const handler = baseApi({ auth: false }).post(async (req, res) => {
  const validatedBody = z
    .object({
      firstName: z.string().min(1).max(50),
      lastName: z.string().min(1).max(50),
      email: z.string().email(),
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

  await Subscriber.create(validatedBody);

  try {
    const brand = process.env.APP_NAME || '';
    const slackMessage = `🎯 **New Subscriber Alert!**

📧 **${validatedBody.firstName} ${validatedBody.lastName}** (${validatedBody.email}) just requested an invite code!

👋 They're waiting at the door and ready to join${brand ? ` ${brand}` : ''}. Time to roll out the red carpet!

🎟️ An admin can generate their invite code with custom credits and storage in the admin panel.

📍 *Admin Panel > Subscribers* to convert them to a user.`;

    await postMessageToSlack(slackMessage);
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
