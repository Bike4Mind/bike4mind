import { ORGANIZATION_SUBSCRIPTION_MIN_SEATS } from '@client/lib/subscriptions/constants';
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
     * Number of seats to subscribe to. Minimum enforced by ORGANIZATION_SUBSCRIPTION_MIN_SEATS.
     */
    quantity: z.number().min(ORGANIZATION_SUBSCRIPTION_MIN_SEATS),

    /**
     * The organization that is subscribing. If not provided, a new organization will be created.
     */
    organizationId: z.string().optional(),

    /**
     * The URL to redirect to after the subscription is created.
     */
    callbackUrl: z.string(),

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
