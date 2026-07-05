/**
 * Organization Access Verification Utility
 *
 * Shared utility for verifying user access to organization resources.
 * Used by org-scoped API endpoints (webhooks, GitHub connection, etc.)
 *
 * Security:
 * - Returns NotFoundError for both missing and unauthorized (prevents enumeration)
 * - Admin users have access to all organizations
 * - Non-admin users must be owner or manager
 */

import { organizationRepository } from '@bike4mind/database/infra';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { Types } from 'mongoose';

/**
 * Validate MongoDB ObjectId format
 */
function isValidObjectId(id: string): boolean {
  return Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;
}

/**
 * Verify user has update access to the organization
 *
 * @param user - The authenticated user
 * @param orgId - The organization ID to verify access for
 * @returns The organization document if access is granted
 * @throws BadRequestError if orgId is invalid format
 * @throws NotFoundError if org doesn't exist or user doesn't have access
 */
export async function verifyOrgAccess(user: { id: string; isAdmin: boolean }, orgId: string) {
  // P1: Validate orgId format to prevent invalid database queries
  if (!orgId || !isValidObjectId(orgId)) {
    throw new BadRequestError('Invalid organization ID');
  }

  // Admin users have access to all organizations
  if (user.isAdmin) {
    const org = await organizationRepository.findById(orgId);
    if (!org) {
      throw new NotFoundError('Organization not found');
    }
    return org;
  }

  // For non-admin users, check if they are owner or manager
  const org = await organizationRepository.findById(orgId);
  if (!org) {
    throw new NotFoundError('Organization not found');
  }

  // Check if user is owner or manager (has update access)
  const isOwner = org.userId === user.id;
  const isManager = org.managerId === user.id;

  if (!isOwner && !isManager) {
    // Return same error for not found and not authorized (prevent enumeration)
    throw new NotFoundError('Organization not found');
  }

  return org;
}
