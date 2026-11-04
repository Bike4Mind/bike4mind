import type { IUserDocument } from '@bike4mind/common';
import {
  adminSettingsRepository,
  creditTransactionRepository,
  organizationRepository,
  usageEventRepository,
  userRepository,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { recordOperationalUsage } from '@bike4mind/services';
import { REKOGNITION_MODERATION_USD_PER_CALL } from '@bike4mind/utils/imageModeration';
import type { ModerateUploadedFileArgs } from '@bike4mind/server-utils/s3/moderateUploadedFile';
import { activePlanResolver } from '@server/entitlements/activeSubscriptions';
import { reserveImageModerationCalls } from '@server/s3/imageModerationBudget';

/**
 * The allowance and usage hooks moderateUploadedFile runs an uploaded image's scan through: detector
 * calls are spent from the uploader's daily allowance (imageModerationBudget.ts) and recorded as
 * operational usage against the file. The uploader is read at most once, and only for an image.
 */
export function buildUploadModerationMeter(args: {
  userId: string;
  fabFileId: string;
  logger: Logger;
}): Pick<ModerateUploadedFileArgs, 'reserveModerationCalls' | 'recordModerationCalls'> {
  const { userId, fabFileId, logger } = args;
  let uploader: Promise<IUserDocument | null> | undefined;
  const loadUploader = () => (uploader ??= userRepository.findById(userId));

  return {
    reserveModerationCalls: async calls => {
      // An uploader that no longer exists is charged the free allowance under its id.
      const user = await loadUploader();
      return reserveImageModerationCalls(user ?? { id: userId }, calls);
    },
    recordModerationCalls: async calls => {
      try {
        const user = await loadUploader();
        if (!user) return;
        const organization = user.organizationId ? await organizationRepository.findById(user.organizationId) : null;
        // An unresolved organization must never redirect its charge to the uploader.
        if (user.organizationId && !organization) {
          throw new Error(`Billing organization ${user.organizationId} could not be resolved`);
        }
        await recordOperationalUsage(
          {
            requestId: fabFileId,
            user,
            organization,
            feature: 'operations',
            provider: 'aws-rekognition',
            model: 'detect-moderation-labels',
            inputTokens: 0,
            costUsd: calls * REKOGNITION_MODERATION_USD_PER_CALL,
            source: 'system',
          },
          {
            db: {
              usageEvents: usageEventRepository,
              adminSettings: adminSettingsRepository,
              creditTransactions: creditTransactionRepository,
              users: userRepository,
              organizations: organizationRepository,
              activePlans: activePlanResolver,
            },
            logger,
          }
        );
      } catch (error) {
        logger.warn(`[uploadModerationMeter] could not record moderation usage for ${fabFileId}: ${String(error)}`);
      }
    },
  };
}
