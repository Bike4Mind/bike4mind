import { BadRequestError } from '@bike4mind/utils';
import {
  ORGANIZATION_SUBSCRIPTION_MAX_SEATS,
  ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
  ORGANIZATION_SUBSCRIPTION_PRICE_ID,
} from '@client/lib/subscriptions/constants';
import { OrgSubscriptionSubscribeSchema, StripeSubscriptionMetadataSchema } from '@client/lib/subscriptions/schema';
import { SubscriptionOwnerType, isDelinquentSubscriptionStatus } from '@client/lib/subscriptions/types';
import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@server/utils/config';
import { createCustomer, CustomerType, stripe } from '@server/integrations/stripe/stripe';
import { appendSuccessParams, isAllowedCallbackOrigin } from '@server/integrations/stripe/callbackUrl';
import { Request } from 'express';
import { z } from 'zod';
import { subscriptionRepository } from '@server/models/Subscription';
import { requireStripeWebhook } from '@server/middlewares/requireStripeWebhook';
import { verifyOrgOwner } from '@server/utils/orgAccess';
import { attachOrgStripeCustomer } from '@server/integrations/stripe/attachOrgStripeCustomer';

const handler = baseApi()
  .use(requireStripeWebhook())
  .post<Request<{}, {}, z.infer<typeof OrgSubscriptionSubscribeSchema>>>(async (req, res) => {
    const { priceId, organizationId, quantity, organizationData, callbackUrl } = OrgSubscriptionSubscribeSchema.parse(
      req.body
    );

    if (priceId !== ORGANIZATION_SUBSCRIPTION_PRICE_ID) {
      throw new BadRequestError('Invalid Organization Subscription Price ID');
    }

    // Restrict the Stripe success/cancel redirect to the deployed app origin. An
    // external callbackUrl is an open-redirect/phishing vector off Stripe's hosted
    // checkout page. The schema only guarantees a parseable URL, so this origin check
    // is what actually confines the redirect - and it matters more now that the
    // success redirect carries the completed checkout session id. Same pairing in
    // pages/api/subscriptions/subscribe.ts, pages/api/stripe/portal.ts and
    // pages/api/admin/organizations/[id]/convert-to-paid.ts - keep them in sync.
    if (!isAllowedCallbackOrigin(callbackUrl)) {
      throw new BadRequestError('callbackUrl must point to the deployed application origin');
    }

    // IDOR guard: only the org's billing owner (or a platform admin) may put an existing org on a
    // paid plan. `organizationId` arrives in the request body, so without this any authenticated
    // caller could name another tenant's org and have this route stamp a Stripe customer onto that
    // org's document, read its headcount back off the returned checkout page, and open a session
    // against its subscription. Deliberately the FIRST thing that touches the org: every lookup,
    // createCustomer and repository write below is downstream of it, so a rejected caller leaves
    // nothing behind. Owner-only matches subscriptions/update-seats.ts and stripe/portal.ts -
    // buying seats is at least as consequential as changing how many you already have.
    //
    // No id means "create a new org" (the organizationData branch): there is no existing tenant to
    // authorize against, so the gate does not apply.
    //
    // Do NOT read that as the two being mutually exclusive. `OrgSubscriptionSubscribeSchema`'s
    // refine requires only that AT LEAST ONE of organizationId / organizationData is present, so a
    // caller may send both. The id wins here and the org is gated, but the metadata block below
    // still keys off organizationData, which sends the invoice webhook down its create-a-new-org
    // branch against this org's Stripe customer. Pre-existing and tracked separately; it is a
    // billing-attribution bug, not an authorization one, and this gate does not widen it.
    const organization = organizationId ? await verifyOrgOwner(req.user, organizationId) : null;

    // Everything below keys off the CANONICAL id from the gated document, never the raw body
    // string. `isValidObjectId` accepts uppercase hex and findById casts it, so an owner could
    // send an uppercase spelling of their own org id, miss the byte-exact `ownerId` match in the
    // duplicate-subscription guard below (rows are written from `org.id`, always lowercase - see
    // Subscription.ts and lib/userSubscriptions/serverUtils.ts) and open a second checkout
    // session: a double charge with only one entitlement. Same reason the Stripe metadata uses it.
    const gatedOrganizationId = organization?.id;

    // Refuse a second live subscription for the org. This read used to be active-only, so an org
    // whose subscription was past_due - invisible to the guard - could start a second checkout
    // while the first kept retrying the card and emailing. Non-terminal rows block; a terminal
    // row (canceled, incomplete_expired) does not, so a lapsed org can still subscribe again.
    if (gatedOrganizationId) {
      const liveSubscriptions = await subscriptionRepository.findNonTerminalSubscriptionsByOwner(
        SubscriptionOwnerType.Organization,
        gatedOrganizationId
      );

      // The price is pinned to ORGANIZATION_SUBSCRIPTION_PRICE_ID above, so for an org this is
      // "any non-terminal subscription"; keep the match so the guard reads the same for any price.
      const blockingSubscription = liveSubscriptions.find(subscription => subscription.priceId === priceId);

      if (blockingSubscription) {
        throw new BadRequestError(
          isDelinquentSubscriptionStatus(blockingSubscription.status)
            ? 'This organization has a subscription with a payment problem. Fix or cancel it in the Billing Portal before subscribing again.'
            : 'An active subscription already exists for this organization'
        );
      }
    }

    let minSeats = ORGANIZATION_SUBSCRIPTION_MIN_SEATS;

    let customerId: string | undefined;
    if (organization) {
      // Race-safe: a plain `organizationRepository.update(organization)` here was last-writer-wins,
      // so two concurrent owner requests each created a Stripe customer and the loser's write
      // orphaned the winner's. The gate now reads the org one round trip earlier than the old
      // inline findById did, which widens that window, so the conditional update is what keeps it
      // closed. See attachOrgStripeCustomer for the full argument.
      customerId = await attachOrgStripeCustomer(organization);

      // Clamp at the ceiling so an over-cap org's checkout minimum can't exceed the maximum (#1424) -
      // without this, minimum > maximum makes Stripe reject the session and the self-serve checkout wedges.
      minSeats = Math.min(
        Math.max(ORGANIZATION_SUBSCRIPTION_MIN_SEATS, organization.users.length + 1),
        ORGANIZATION_SUBSCRIPTION_MAX_SEATS
      );
    } else {
      const customer = await createCustomer({
        email: req.user.email!,
        name: organizationData?.name ?? req.user.email!,
        type: CustomerType.Organization,
      });

      customerId = customer.id;
    }

    const metadata = StripeSubscriptionMetadataSchema.parse({
      userId: req.user.id,
      stage: Config.STAGE,
      ownerType: SubscriptionOwnerType.Organization,
      ...(organizationData
        ? { newOrganizationName: organizationData.name }
        : {
            // The gated document's canonical id, not the body string - this value becomes the
            // subscription row's `ownerId` via the invoice webhook, and the duplicate guard above
            // matches on it byte-for-byte.
            organizationId: gatedOrganizationId,
          }),
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: quantity,
          adjustable_quantity: {
            enabled: true,
            minimum: minSeats,
            maximum: ORGANIZATION_SUBSCRIPTION_MAX_SEATS,
          },
        },
      ],
      // Carries the Stripe session id alongside the existing success marker so the
      // returning client can report revenue (see api/subscriptions/checkout-session.ts).
      success_url: appendSuccessParams(callbackUrl),
      cancel_url: callbackUrl,
      subscription_data: {
        metadata,
      },
    });

    return res.status(200).json({ sessionUrl: session.url });
  });

export default handler;
