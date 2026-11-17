import { IOrganizationDocument, IUserDocument, toSafeOrganization } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { User, organizationRepository, userRepository } from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';

type PointerOwner = (Pick<IUserDocument, 'groups' | 'isAdmin'> & { _id: unknown }) | null;

/**
 * The pointer can outlive the membership (legacy pointers, removals that skipped the clear), so
 * re-check it against the TARGET user's ACL. Platform admins keep theirs, matching
 * clearStaleOrganizationPointers in packages/scripts.
 */
async function isStillAccessible(user: PointerOwner, organization: IOrganizationDocument): Promise<boolean> {
  if (!user) return false;
  if (user.isAdmin) return true;
  // findAccessibleById reads only id and groups; the repository interface types a full document.
  const aclUser = { id: String(user._id), groups: user.groups ?? [] } as unknown as IUserDocument;
  const accessible = await organizationRepository.shareable.findAccessibleById(aclUser, String(organization.id));
  return accessible !== null;
}

/**
 * A user's active organization: read it (GET) or clear the pointer (DELETE).
 */
const handler = baseApi()
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const userId = req.query.id;

      // The organization document carries billing and member data, so only the
      // user themselves or an admin may read their org via this route.
      if (userId !== req.user.id && !req.user.isAdmin) {
        throw new ForbiddenError('Not authorized to view this organization');
      }

      const user = await User.findById(userId)
        .populate({
          path: 'organizationId',
          populate: {
            path: 'logo',
          },
        })
        .select('organizationId groups isAdmin');
      const pointed = (user?.organizationId as unknown as IOrganizationDocument | null | undefined) ?? null;
      const organization = pointed && (await isStillAccessible(user, pointed)) ? pointed : null;

      // The caller may be a member (not owner) of their primary org, so strip billing
      // identifiers unless they own it or are an admin.
      return res.json(toSafeOrganization(organization, { userId: req.user.id, isAdmin: req.user.isAdmin }));
    })
  )
  // Clear the user's active-organization pointer, returning them to their personal scope + balance.
  // The self-service escape for #1428 - `leave` refuses the owner, so an owner pointed at an
  // unfunded org otherwise has no way out. authz (self or admin) is enforced in the service.
  .delete(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const userId = req.query.id ?? '';
      await organizationService.clearActiveOrganization(req.user, { userId }, { db: { users: userRepository } });
      return res.status(204).end();
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
