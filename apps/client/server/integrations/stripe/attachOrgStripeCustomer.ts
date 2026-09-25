import { Organization, organizationRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { createCustomer, CustomerType } from './stripe';

/** The slice of an organization document this needs; the caller passes a full IOrganizationDocument. */
type OrgStripeCustomerTarget = {
  id: string;
  name: string;
  billingContact: string;
  stripeCustomerId?: string | null;
};

/**
 * Resolve an organization's Stripe customer id, creating the customer on first use.
 *
 * The conditional `findOneAndUpdate` is the whole point. Two concurrent requests that both find
 * `stripeCustomerId` unset would each create a Stripe customer; with a plain whole-document
 * `organizationRepository.update(org)` both then persist, so the loser's write orphans the
 * winner's paid Stripe record AND clobbers every other field with a document read before the
 * winner's changes. Guarding on `stripeCustomerId: null` makes exactly one writer win, and the
 * loser adopts the winner's id instead.
 *
 * `deletedAt: null` in the filter follows this model's own convention (`OrganizationModel.ts:247`):
 * `softDeletePlugin` hooks `find`/`findOne` but NOT `findOneAndUpdate`, so without it a delete
 * landing between the gate's read and this write would stamp a customer onto a dead tenant.
 * `verifyOrgOwner` already rejects a soft-deleted org (its `findById` is hooked), so this only
 * covers that race - and when it fires, the reload below misses too and the caller gets the
 * BadRequestError rather than a checkout session against an organization that no longer exists.
 *
 * Mutates `organization.stripeCustomerId` so a caller still holding the document (for
 * `users.length`, `name`, ...) sees the same object it passed in.
 *
 * Sole caller today is `organizations/subscriptions/subscribe.ts`. Three copies of this dance
 * survive elsewhere and are deliberately NOT folded in here:
 * - `stripe/portal.ts:57-81` and `admin/organizations/[id]/convert-to-paid.ts:61-87` run the same
 *   org-model dance; both still lack the `deletedAt: null` guard described above.
 * - `stripe/portal.ts:101+` runs it for a USER's customer id against the User model, where the
 *   model, the type and the error wording all differ.
 * Folding them is the right end state but wants its own PR: `portal.ts` holds the pattern twice,
 * for two different models, and has no test file at all. Until then, if you change the concurrency
 * contract here, change it in all three.
 */
export async function attachOrgStripeCustomer(organization: OrgStripeCustomerTarget): Promise<string> {
  if (organization.stripeCustomerId) {
    return organization.stripeCustomerId;
  }

  const customer = await createCustomer({
    email: organization.billingContact,
    name: organization.name,
    type: CustomerType.Organization,
  });

  const won = await Organization.findOneAndUpdate(
    { _id: organization.id, stripeCustomerId: null, deletedAt: null },
    { $set: { stripeCustomerId: customer.id } },
    { new: true }
  );

  if (won) {
    organization.stripeCustomerId = customer.id;
    return customer.id;
  }

  // Lost the race: another request persisted first. Adopt its id rather than ours, so the
  // checkout session is opened against the customer the organization document actually points at.
  const fresh = await organizationRepository.findById(organization.id);
  if (!fresh?.stripeCustomerId) {
    throw new BadRequestError('Failed to attach Stripe customer to organization');
  }
  organization.stripeCustomerId = fresh.stripeCustomerId;
  return fresh.stripeCustomerId;
}
