import { CREDITS_PAGE_READ } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { PaymentFulfillmentQuery } from '@client/app/utils/paymentFulfillment';
import { readPaymentFulfillment } from '@server/admin/paymentFulfillment/read';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';

const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: CREDITS_PAGE_READ } })
  .use(rateLimit({ limit: 10, windowMs: 60_000, bucket: 'admin-payment-fulfillment' }))
  .get(
    asyncHandler(async (req, res) => {
      const parsed = PaymentFulfillmentQuery.safeParse(req.query);
      if (!parsed.success) throw new BadRequestError('Invalid payment fulfillment filters');
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json(await readPaymentFulfillment(parsed.data, req.logger));
    })
  );

export default handler;
