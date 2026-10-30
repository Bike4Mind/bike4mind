import { baseApi } from '@server/middlewares/baseApi';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';

const handler = baseApi().get(async (req, res) => {
  const prices = await stripe.prices.list({
    active: true,
    limit: 100,
  });

  return res.json(prices.data);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
