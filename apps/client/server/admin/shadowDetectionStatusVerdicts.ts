import { isAbuseSuspensionReason, type ShadowDetectionItem } from '@bike4mind/common';
import { shadowDetectionRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import type { AdminAuditWriter } from '@bike4mind/server-utils/utils/adminAudit';

export type AccountStatusChange = {
  userId: string;
  adminId: string;
  /** isBanned before and after the admin's update committed. */
  wasSuspended: boolean;
  isSuspended: boolean;
  /** The audited suspend or reinstate reason; absent when the update carried none. */
  reason: string | undefined;
  /**
   * The reinstatement undoes the admin's own suspension (an Undo action): the grades that suspension
   * recorded are removed rather than replaced with legitimate_human.
   */
  undo?: boolean;
};

/**
 * Grades the shadow detections naming an account an admin just suspended or reinstated, so the
 * Detections queue does not ask for a verdict an admin has already given (repository rules in
 * ShadowDetectionModel gradeForSuspension / gradeForReinstatement). A suspension counts only with an
 * abuse reason (isAbuseSuspensionReason). Each graded record gets the same audit entry a manual grade
 * does. An undone suspension removes its own grades instead (revertSuspensionGrades). Runs after the
 * account change committed and never throws: grading must not undo it.
 */
export async function gradeDetectionsForStatusChange(
  change: AccountStatusChange,
  deps: { writeAudit: AdminAuditWriter; logger: Logger }
): Promise<ShadowDetectionItem[]> {
  const { userId, adminId, wasSuspended, isSuspended, reason } = change;
  const reverting = !isSuspended && change.undo === true;
  if (wasSuspended === isSuspended || !reason) return [];
  if (isSuspended && !isAbuseSuspensionReason(reason)) return [];

  const input = {
    userId,
    reviewerId: adminId,
    reason: isSuspended ? `Account suspended: ${reason}` : `Account reinstated: ${reason}`,
  };
  let graded: ShadowDetectionItem[];
  try {
    if (isSuspended) graded = await shadowDetectionRepository.gradeForSuspension(input);
    else if (reverting) graded = await shadowDetectionRepository.revertSuspensionGrades(input);
    else graded = await shadowDetectionRepository.gradeForReinstatement(input);
  } catch (error) {
    deps.logger.error(`Grading shadow detections for account ${userId} failed`, error);
    return [];
  }

  for (const item of graded) {
    try {
      await deps.writeAudit({
        action: 'security.detection.reviewed',
        target: { kind: 'system', id: item.id, displayName: `Shadow detection ${item.id}` },
        summary: reverting
          ? `removed the confirmed_abuse grade from a ${item.detector} detection by undoing the account's suspension`
          : `graded a ${item.detector} detection as ${item.verdict} by ${isSuspended ? 'suspending' : 'reinstating'} the account`,
        reason: input.reason,
        details: {
          detectionId: item.id,
          detector: item.detector,
          policyVersion: item.policyVersion,
          wouldAction: item.wouldAction,
          verdict: item.verdict,
          userIds: item.userIds,
          source: isSuspended ? 'suspension' : reverting ? 'suspension_undone' : 'reinstatement',
        },
      });
    } catch (error) {
      deps.logger.error(`Audit entry failed for shadow detection verdict ${item.id}`, error);
    }
  }
  return graded;
}
