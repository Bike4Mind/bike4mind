import { organizationRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@server/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { stripe } from '@server/integrations/stripe/stripe';
import { z } from 'zod';
import { ORGANIZATION_SUBSCRIPTION_MIN_SEATS } from '@client/lib/subscriptions/constants';
import { SubscriptionOwnerType, SubscriptionSource } from '@client/lib/subscriptions/types';
import { subscriptionRepository } from '@server/models/Subscription';
import dayjs from 'dayjs';
import { requireStripeWebhook } from '@server/middlewares/requireStripeWebhook';
import {
  countPendingOrganizationInvites,
  validateSeatChange,
  resolveSubscriptionSource,
} from '@server/services/organizationService';

const UpdateSeatsSchema = z.object({
  organizationId: z.string(),
  seats: z.number().min(ORGANIZATION_SUBSCRIPTION_MIN_SEATS),
});

const handler = baseApi()
  .use(requireStripeWebhook())
  .post(async (req, res) => {
    const { organizationId, seats } = UpdateSeatsSchema.parse(req.body);

    const organization = await organizationRepository.findById(organizationId);
    if (!organization) throw new NotFoundError('Organization not found');

    // IDOR guard: only the org's billing owner (or an admin) may mutate seats.
    // Without this, any authenticated user could pass another tenant's org id
    // and trigger stripe.subscriptions.update() against their payment method.
    if (organization.userId !== req.user.id && !req.user.isAdmin) {
      throw new ForbiddenError('Not authorized to change seats for this organization');
    }

    // Admin-granted orgs do not flow through this endpoint - convert-to-paid
    // is the only sanctioned path to enable Stripe billing for them.
    const activeSubs = await subscriptionRepository.findActiveSubscriptionsByOwner(
      SubscriptionOwnerType.Organization,
      organization.id
    );
    if (activeSubs.some(s => resolveSubscriptionSource(s) === SubscriptionSource.AdminGrant)) {
      throw new ForbiddenError('Contact support to enable billing for this organization.');
    }

    if (!organization.stripeCustomerId) {
      throw new BadRequestError('Organization has no associated Stripe customer');
    }

    // Validate against current team size and platform min/max. The actual DB
    // write happens in the Stripe webhook (customer.subscription.updated) once
    // Stripe accepts the change. Pending invites must count toward the floor -
    // without this, a customer can shrink below accepted+pending and pending
    // acceptances fail later with "org full".
    const pendingInviteCount = await countPendingOrganizationInvites(organization.id);
    validateSeatChange(organization, seats, { type: 'stripe' }, pendingInviteCount);

    const subscriptions = await stripe.subscriptions.list({
      customer: organization.stripeCustomerId,
      limit: 1,
      status: 'active',
    });

    const subscription = subscriptions.data[0];
    if (!subscription) throw new BadRequestError('No active subscription found');

    const currentSeats = subscription.items.data[0].quantity || 0;

    // Get proration preview
    const preview = await stripe.subscriptions.update(subscription.id, {
      items: [
        {
          id: subscription.items.data[0].id,
          quantity: seats,
        },
      ],
      // Use 'none' for seat decreases (no refund) and 'always_invoice' for increases
      proration_behavior: seats < currentSeats ? 'none' : 'always_invoice',
    });

    const [updatedItem] = preview.items.data;

    // The webhook will handle updating the seats in our database
    const currentTeamSize = organization.users.length + 1 + pendingInviteCount;
    return res.status(200).json({
      seats,
      currentTeamSize,
      minimumRequiredSeats: Math.max(ORGANIZATION_SUBSCRIPTION_MIN_SEATS, currentTeamSize),
      nextBillingDate: dayjs.unix(updatedItem.current_period_end).format(),
      proration: {
        amount: updatedItem.price.unit_amount ? (updatedItem.quantity! * updatedItem.price.unit_amount) / 100 : null,
        currency: preview.currency,
      },
    });
  });

export default handler;
