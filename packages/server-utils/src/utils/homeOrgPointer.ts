import type { IUserDocument } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';

export type HomeOrgPointerOwner = Partial<Pick<IUserDocument, 'groups' | 'isAdmin'>> & { _id: unknown };

/**
 * The user's populated home organization (`pointed`, the populated `organizationId` path), or null
 * when the user can no longer reach it. The stored pointer can outlive the membership (legacy
 * pointers, removals that skipped the clear), so it is re-checked against the POINTER OWNER's ACL,
 * not the caller's. Platform admins keep theirs. Keep-predicate mirrored in
 * packages/scripts/src/clearStaleOrganizationPointers.ts (gradeOrg); change both together.
 */
export async function accessibleHomeOrg<T extends { id: string }>(
  owner: HomeOrgPointerOwner | null | undefined,
  pointed: T | null | undefined
): Promise<T | null> {
  if (!owner || !pointed) return null;
  if (owner.isAdmin) return pointed;
  // findAccessibleById reads only id and groups; the repository interface types a full document.
  const aclUser = { id: String(owner._id), groups: owner.groups ?? [] } as unknown as IUserDocument;
  const accessible = await organizationRepository.shareable.findAccessibleById(aclUser, String(pointed.id));
  return accessible ? pointed : null;
}
