/**
 * Quest Master Plan Access Verification Utility
 *
 * Shared utility for verifying user write-access to quest master plan resources.
 * Used by quest-master-plans API endpoints (handoff, blockers, decisions, etc.)
 *
 * Follows the same pattern as orgAccess.ts:
 * - Throws typed HTTPError subclasses (caught by baseApi's errorHandler)
 * - Returns the verified plan document on success
 *
 * Security:
 * - Write access requires ownership or explicit sharing (public = read-only)
 * - Legacy plans without userId are backfilled on first write access
 */

import { questMasterPlanRepository, sessionRepository } from '@bike4mind/database';
import { IQuestMasterPlanDocument } from '@bike4mind/common';
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from '@bike4mind/common';
import { Types } from 'mongoose';

export function isValidObjectId(id: string): boolean {
  return Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;
}

/** Regex pattern for valid quest/sub-quest ID strings (alphanumeric, hyphens, underscores, dots) */
export const QUEST_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;

/**
 * Verify user has write access to a quest master plan.
 *
 * Write access: plan owner or shared collaborator.
 * Public visibility grants read-only access and is excluded here.
 *
 * @param userId - The authenticated user's ID (from req.user?.id)
 * @param planId - The plan ID from the route parameter
 * @returns The plan document if access is granted
 * @throws UnauthorizedError if userId is missing
 * @throws BadRequestError if planId is invalid format
 * @throws NotFoundError if plan doesn't exist
 * @throws ForbiddenError if user doesn't have write access
 *
 * @sideEffects For legacy plans without userId, backfills userId from session
 * ownership on first successful write-access check (one-time migration).
 */
export async function verifyQuestPlanWriteAccess(
  userId: string | undefined,
  planId: string
): Promise<IQuestMasterPlanDocument> {
  if (!userId) {
    throw new UnauthorizedError('Unauthorized');
  }

  if (!isValidObjectId(planId)) {
    throw new BadRequestError('Invalid plan ID format');
  }

  const plan = await questMasterPlanRepository.findById(planId);
  if (!plan) {
    throw new NotFoundError('Quest plan not found');
  }

  let hasAccess = false;

  if (plan.userId) {
    hasAccess = plan.userId === userId || (plan.sharedWith?.includes(userId) ?? false);
  } else {
    // Legacy plans without userId - check session ownership and backfill
    if (isValidObjectId(plan.notebookId)) {
      const session = await sessionRepository.findById(plan.notebookId);
      if (session && session.userId === userId) {
        hasAccess = true;
        plan.userId = session.userId;
        await questMasterPlanRepository.update(plan);
      }
    }
  }

  if (!hasAccess) {
    throw new ForbiddenError('Access denied');
  }

  return plan;
}
