import { Subscriber } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { postMessageToSlack } from '@server/integrations/slack/slack';
import * as z from 'zod';

const handler = baseApi({ auth: false }).post(async (req, res) => {
  const validatedBody = z
    .object({
      firstName: z.string().min(1).max(50),
      lastName: z.string().min(1).max(50),
      email: z.string().email(),
    })
    .parse(req.body);

  const existingSubscriber = await Subscriber.findOne({ email: validatedBody.email, deletedAt: null });
  if (existingSubscriber) {
    throw new BadRequestError('Email already registered');
  }

  const subscriber = await Subscriber.create(validatedBody);

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

  return res.status(201).json(subscriber);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
