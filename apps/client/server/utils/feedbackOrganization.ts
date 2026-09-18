import { User } from '@bike4mind/database';
import { IOrganizationDocument } from '@bike4mind/common';

/** How a Feedback writer identifies the submitter: an authenticated session's own id, or - for
 * the anonymous branch of the create handler only - the email the request carried.
 *
 * `email` is `string`, not `string | undefined`, on purpose: `User.findOne({ email: undefined })`
 * serializes the key as BSON null and matches an arbitrary email-less account (the trap is
 * documented at `UserModel.ts`), and what it would return here is an authorization key. */
export type FeedbackSubmitterLookup = { userId: string } | { email: string };

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
  // Belt and braces over the type above: an empty or absent email must not be handed to the query,
  // because it would match an arbitrary email-less account rather than nothing.
  if ('email' in lookup && !lookup.email) return { organization: 'Unknown', organizationId: null };

  // Typed populate rather than a cast through `unknown`: the cast erased the User schema's ref, so
  // pointing `organizationId` at a different collection would still have compiled.
  const user =
    'userId' in lookup
      ? await User.findById(lookup.userId).populate<{ organizationId: IOrganizationDocument }>('organizationId')
      : await User.findOne({ email: lookup.email }).populate<{ organizationId: IOrganizationDocument }>(
          'organizationId'
        );

  const organizationDoc = user?.organizationId;
  return {
    organization: organizationDoc?.name || 'Unknown',
    organizationId: organizationDoc?.id ?? null,
  };
}
