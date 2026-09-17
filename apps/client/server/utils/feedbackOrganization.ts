import { User } from '@bike4mind/database';
import { IOrganizationDocument } from '@bike4mind/common';

/** How a Feedback writer identifies the submitter: an authenticated session's own id, or - for
 * the anonymous branch of the create handler only - the email the request carried. */
export type FeedbackSubmitterLookup = { userId: string } | { email: string | undefined };

/**
 * Resolves the two organization fields every producer of `Feedback` rows stamps onto a report:
 * `organization`, the display label an admin triages by, and `organizationId`, the key an
 * org-scoped reader filters the list on.
 *
 * Shared rather than re-derived per writer because the id half is an authorization key - two
 * producers resolving it independently is two chances to stamp a report into the wrong org's
 * view. Note the asymmetry is deliberate: the label falls back to 'Unknown' so the admin list
 * always renders something, while the id falls back to null rather than a guess, because a
 * report with no resolvable org must be invisible to every org-scoped reader rather than
 * visible to an arbitrary one.
 */
export async function resolveFeedbackOrganization(
  lookup: FeedbackSubmitterLookup
): Promise<{ organization: string; organizationId: string | null }> {
  const user =
    'userId' in lookup
      ? await User.findById(lookup.userId).populate('organizationId')
      : await User.findOne({ email: lookup.email }).populate('organizationId');

  const organizationDoc = user?.organizationId as unknown as IOrganizationDocument | undefined;
  return {
    organization: organizationDoc?.name || 'Unknown',
    organizationId: organizationDoc?.id ?? null,
  };
}
