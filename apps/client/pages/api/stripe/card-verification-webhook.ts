import type Stripe from 'stripe';
import { baseApi } from '@server/middlewares/baseApi';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { Config } from '@bike4mind/server-utils/utils/config';
import { CardVerification } from '@server/billing/cardVerificationModel';
import { cardVerificationRuntime, finishCardVerification } from '@server/billing/cardVerificationRuntime';

const handler = baseApi({ auth: false }).post(async (req, res) => {
  const secret = Config.CARD_VERIFICATION_WEBHOOK_SECRET;
  if (!secret?.startsWith('whsec_')) return res.status(503).json({ error: 'Webhook unavailable' });
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 1048576) return res.status(413).end();
    chunks.push(data);
  }
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(Buffer.concat(chunks), req.headers['stripe-signature'] as string, secret);
  } catch {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  if (!['setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled'].includes(event.type))
    return res.status(200).end();
  const intent = event.data.object as Stripe.SetupIntent;
  const record = await CardVerification.findOne({ setupIntentId: intent.id, livemode: event.livemode }).lean();
  if (!record || record.environment !== Config.STAGE) return res.status(200).end();
  if (event.type === 'setup_intent.setup_failed') {
    const runtime = await cardVerificationRuntime();
    if (!runtime.guards) return res.status(503).end();
    await runtime.guards.recordFailure(intent, record);
  } else {
    await finishCardVerification(record.verificationId, record.userId);
  }
  return res.status(200).end();
});

export const config = { api: { bodyParser: false, externalResolver: true } };
export default handler;
