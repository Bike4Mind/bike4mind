import {
  ORGANIZATION_SUBSCRIPTION_MAX_SEATS,
  ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
} from '@client/lib/subscriptions/constants';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { z } from 'zod';

export const BaseStripeSubscriptionMetadata = z.object({
  userId: z.string(),
  stage: z.string(),
});

export const UserStripeSubscriptionMetadata = BaseStripeSubscriptionMetadata.extend({
  ownerType: z.literal(SubscriptionOwnerType.User),
});

export const OrganizationStripeSubscriptionMetadata = BaseStripeSubscriptionMetadata.extend({
  ownerType: z.literal(SubscriptionOwnerType.Organization),
  organizationId: z.string().optional(),
  newOrganizationName: z.string().optional(),
}).refine(data => data.organizationId !== undefined || data.newOrganizationName !== undefined, {
  path: ['organizationId'], // path of error
  error: 'Either organizationId or newOrganizationName must be provided',
});

export const StripeSubscriptionMetadataSchema = z.union([
  UserStripeSubscriptionMetadata,
  OrganizationStripeSubscriptionMetadata,
]);

export const OrgSubscriptionSubscribeSchema = z
  .object({
    /**
     * The Stripe price ID to subscribe to.
     */
    priceId: z.string(),

    /**
     * Number of seats to subscribe to. Whole seats only, bounded by the platform
     * min/max - this value flows into Stripe checkout line_items and into
     * organization.seats at creation, so a non-integer or over-cap value must be
     * rejected here rather than relying on Stripe to bounce it.
     */
    quantity: z.number().int().min(ORGANIZATION_SUBSCRIPTION_MIN_SEATS).max(ORGANIZATION_SUBSCRIPTION_MAX_SEATS),

    /**
     * The organization that is subscribing. If not provided, a new organization will be created.
     *
     * `min(1)` is load-bearing, not cosmetic: the refine below only asks that the key be present,
     * so `""` used to satisfy it, then read as falsy in the handler - skipping BOTH the owner gate
     * and the duplicate-subscription guard, and creating a Stripe customer plus a checkout session
     * carrying `metadata.organizationId === ''`. Reject it here instead. A well-formed-looking but
     * non-ObjectId value still reaches the gate, which answers 400.
     */
    organizationId: z.string().min(1).optional(),

    /**
     * The URL to redirect to after the subscription is created. Must be a real URL -
     * origin is further restricted to the deployed app in the subscribe handler
     * (isAllowedCallbackOrigin) to prevent an open-redirect through Stripe's hosted
     * checkout success/cancel pages.
     */
    callbackUrl: z.string().url(),

    /**
     * If organizationId is not provided, this is the data of the organization to create.
     */
    organizationData: z
      .object({
        name: z.string(),
      })
      .optional(),
  })
  .refine(data => data.organizationId !== undefined || data.organizationData !== undefined, {
    path: ['organizationId'], // path of error
    error: 'Either organizationId or organizationData must be provided',
  });

export type OrgSubscriptionSubscribeRequest = z.infer<typeof OrgSubscriptionSubscribeSchema>;
