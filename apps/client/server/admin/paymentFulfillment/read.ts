import { CreditTransaction, userRepository, organizationRepository } from '@bike4mind/database';
import { isStripeConfigured, stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import type { z } from 'zod';
import type {
  PaymentFulfillmentPage,
  PaymentFulfillmentQuery,
  FulfillmentLedgerRow,
} from '@client/app/utils/paymentFulfillment';
import { classifyPayment } from './classify';
import { Config } from '@bike4mind/server-utils/utils/config';

type LedgerRow = Omit<FulfillmentLedgerRow, 'id' | 'createdAt' | 'reversedAt'> & {
  _id: { toString(): string };
  createdAt: Date;
  reversedAt?: Date | null;
};

export async function readPaymentFulfillment(
  query: z.infer<typeof PaymentFulfillmentQuery>
): Promise<PaymentFulfillmentPage> {
  const now = new Date();
  const from = new Date(now.getTime() - query.days * 86400000);
  const page: PaymentFulfillmentPage = {
    availability: 'unavailable',
    checkedAt: now.toISOString(),
    from: from.toISOString(),
    items: [],
    nextCursor: null,
    scanned: 0,
  };
  if (!isStripeConfigured()) return page;
  try {
    const payments = await stripe.paymentIntents.list({
      created: { gte: Math.floor(from.getTime() / 1000), lte: Math.floor(now.getTime() / 1000) },
      limit: query.limit,
      starting_after: query.cursor,
      expand: ['data.latest_charge'],
    });
    const findings = await Promise.all(
      payments.data.map(async payment => {
        if (payment.metadata.environment && payment.metadata.environment !== Config.STAGE) return null;
        const customerId = typeof payment.customer === 'string' ? payment.customer : payment.customer?.id;
        const [user, organization] = customerId
          ? await Promise.all([
              userRepository.findByStripeCustomerId(customerId),
              organizationRepository.findByStripeCustomerId(customerId),
            ])
          : [null, null];
        const owner =
          user && !organization
            ? { id: user.id, type: 'User' as const }
            : organization && !user
              ? { id: organization.id, type: 'Organization' as const }
              : null;
        const charge =
          payment.latest_charge && typeof payment.latest_charge !== 'string' ? payment.latest_charge : null;
        const refunds = charge ? await stripe.refunds.list({ charge: charge.id, limit: 100 }) : null;
        const disputes = charge?.disputed ? await stripe.disputes.list({ charge: charge.id, limit: 2 }) : null;
        const dispute = disputes?.data[0] ?? null;
        const keys = [payment.id];
        const rows = await CreditTransaction.find({
          $or: [
            { stripePaymentIntentId: { $in: keys } },
            ...(refunds?.data.length ? [{ stripeRefundId: { $in: refunds.data.map(refund => refund.id) } }] : []),
            ...(dispute ? [{ stripeDisputeId: dispute.id }] : []),
          ],
        })
          .select('type ownerId ownerType credits createdAt status stripeRefundId stripeDisputeId reversedAt')
          .limit(102)
          .maxTimeMS(3000)
          .lean<LedgerRow[]>();
        if (!user && !organization && rows.length === 0) return null;
        const credits = Number(payment.metadata.credits);
        const pack =
          payment.metadata.environment === Config.STAGE &&
          Number.isFinite(credits) &&
          credits >= 1 &&
          owner?.type === 'User' &&
          (!payment.metadata.userId || payment.metadata.userId === owner.id);
        return classifyPayment(
          {
            id: payment.id,
            createdAt: new Date(payment.created * 1000).toISOString(),
            settledAt: charge?.paid ? new Date(charge.created * 1000).toISOString() : null,
            amount: charge?.amount ?? payment.amount,
            currency: payment.currency,
            livemode: payment.livemode,
            succeeded: payment.status === 'succeeded',
            expectedCredits: pack ? credits : null,
            owner,
            product: pack ? 'credit_pack' : rows.some(row => row.type === 'subscription') ? 'subscription' : 'unknown',
            rows: rows.map(row => ({
              ...row,
              id: row._id.toString(),
              createdAt: row.createdAt.toISOString(),
              reversedAt: row.reversedAt?.toISOString(),
            })),
            refunds:
              refunds?.data.map(refund => ({
                id: refund.id,
                amount: refund.amount,
                status: refund.status,
                createdAt: new Date(refund.created * 1000).toISOString(),
              })) ?? [],
            dispute: dispute
              ? { id: dispute.id, status: dispute.status, createdAt: new Date(dispute.created * 1000).toISOString() }
              : null,
            complete:
              rows.length < 102 &&
              !refunds?.has_more &&
              !disputes?.has_more &&
              (!charge?.disputed || disputes?.data.length === 1) &&
              (payment.status !== 'succeeded' || charge !== null),
          },
          now
        );
      })
    );
    return {
      ...page,
      availability: 'available',
      scanned: payments.data.length,
      nextCursor: payments.has_more ? (payments.data.at(-1)?.id ?? null) : null,
      items: findings
        .filter(item => item !== null)
        .filter(
          item =>
            (!query.state || item.state === query.state) && (!query.ownerType || item.owner?.type === query.ownerType)
        ),
    };
  } catch {
    return page;
  }
}
