import { randomUUID } from 'crypto';
import type { Context } from 'aws-lambda';
import mongoose from 'mongoose';
import { Resource } from 'sst';
import { CreditHolderType, settingsMap } from '@bike4mind/common';
import {
  adminSettingsRepository,
  ApiKeyUsageLog,
  connectDB,
  UsageEvent,
  User,
  UserApiKey,
  userUsagePatternSignalsRepository,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@bike4mind/server-utils/utils/config';
import { userService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { getActiveSubscriptionsForUser } from '@server/entitlements/activeSubscriptions';

const MS_PER_HOUR = 60 * 60 * 1000;
/** Route template ApiKeyUsageLog stores for the credit balance read (apps/client/pages/api/v1/credits.ts). */
export const CREDIT_BALANCE_ENDPOINT = '/api/v1/credits';

export interface UsagePatternSignalsRunOptions {
  logger?: Logger;
  now?: Date;
  /** Same paid test as the API key trust gate: any active own or org-seat subscription. */
  hasActivePlan?: (userId: string) => Promise<boolean>;
}

export interface UsagePatternSignalsRunResult {
  status: 'disabled' | 'success';
  analyzed: number;
  needsReview: number;
  skippedPaid: number;
  errors: number;
}

async function loadSettings() {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['usagePatternSignalsEnabled', 'usagePatternSignalsConfig'] }
  );
  return {
    enabled: getSettingsValue('usagePatternSignalsEnabled', settings, false),
    config: getSettingsValue(
      'usagePatternSignalsConfig',
      settings,
      settingsMap.usagePatternSignalsConfig.schema.parse({})
    ),
  };
}

/** Recently active accounts that pay nothing: no admin, ban, purchase or admin trust approval. */
async function findFreeTierCandidates(since: Date, limit: number) {
  const [spenders, apiCallers] = await Promise.all([
    UsageEvent.distinct('userId', { createdAt: { $gte: since }, ownerType: CreditHolderType.User }),
    ApiKeyUsageLog.distinct('userId', { timestamp: { $gte: since } }),
  ]);
  const ids = Array.from(new Set<string>([...spenders, ...apiCallers])).filter(id => mongoose.isValidObjectId(id));
  return User.find(
    {
      _id: { $in: ids },
      isAdmin: { $ne: true },
      isBanned: { $ne: true },
      apiKeyTrustApproved: { $ne: true },
      lastCreditsPurchasedAt: null,
    },
    { emailVerifiedAt: 1 }
  )
    .limit(limit)
    .lean<{ _id: mongoose.Types.ObjectId; emailVerifiedAt?: Date | null }[]>();
}

async function gatherFacts(
  userId: string,
  emailVerifiedAt: Date | null,
  windowStart: Date,
  sampleSize: number
): Promise<userService.UsagePatternFacts> {
  // One row per request: a single completion can settle several UsageEvent rows.
  const byRequest = {
    $group: { _id: '$requestId', api: { $max: '$apiKeyId' }, web: { $max: { $eq: ['$source', 'web'] } } },
  };
  const [lifetime, windowCount, recent, creditPolls, firstKey] = await Promise.all([
    UsageEvent.aggregate<{ api: number; web: number }>([
      { $match: { userId } },
      byRequest,
      {
        $group: {
          _id: null,
          api: { $sum: { $cond: [{ $gt: ['$api', null] }, 1, 0] } },
          web: { $sum: { $cond: ['$web', 1, 0] } },
        },
      },
    ]),
    UsageEvent.aggregate<{ n: number }>([
      { $match: { userId, createdAt: { $gte: windowStart } } },
      { $group: { _id: '$requestId' } },
      { $count: 'n' },
    ]),
    UsageEvent.aggregate<{ at: Date }>([
      { $match: { userId, createdAt: { $gte: windowStart } } },
      { $group: { _id: '$requestId', at: { $min: '$createdAt' } } },
      { $sort: { at: -1 } },
      { $limit: sampleSize },
    ]),
    ApiKeyUsageLog.countDocuments({
      userId,
      timestamp: { $gte: windowStart },
      endpoint: CREDIT_BALANCE_ENDPOINT,
      method: 'GET',
    }),
    UserApiKey.findOne({ userId }, { createdAt: 1 }).sort({ createdAt: 1 }).lean<{ createdAt?: Date }>(),
  ]);
  return {
    apiKeyRequests: lifetime[0]?.api ?? 0,
    interactiveRequests: lifetime[0]?.web ?? 0,
    requestTimes: recent.map(r => r.at),
    creditPolls,
    completions: windowCount[0]?.n ?? 0,
    emailVerifiedAt,
    firstApiKeyAt: firstKey?.createdAt ?? null,
  };
}

/**
 * Computes usage pattern signals for recently active free-tier users and stores the latest result
 * per user. Read-only for the accounts themselves: nothing here changes a user, key or balance.
 */
export async function runUsagePatternSignals(
  options: UsagePatternSignalsRunOptions = {}
): Promise<UsagePatternSignalsRunResult> {
  const {
    logger = new Logger(),
    now = new Date(),
    hasActivePlan = async (userId: string) => (await getActiveSubscriptionsForUser(userId)).length > 0,
  } = options;
  const result: UsagePatternSignalsRunResult = {
    status: 'success',
    analyzed: 0,
    needsReview: 0,
    skippedPaid: 0,
    errors: 0,
  };

  const { enabled, config } = await loadSettings();
  if (!enabled) return { ...result, status: 'disabled' };

  const candidates = await findFreeTierCandidates(
    new Date(now.getTime() - config.activeWindowHours * MS_PER_HOUR),
    config.maxUsersPerRun
  );
  const windowStart = new Date(now.getTime() - config.lookbackDays * 24 * MS_PER_HOUR);

  for (const user of candidates) {
    const userId = String(user._id);
    try {
      if (await hasActivePlan(userId)) {
        result.skippedPaid++;
        continue;
      }
      const facts = await gatherFacts(userId, user.emailVerifiedAt ?? null, windowStart, config.cadenceSampleSize);
      const signals = userService.computeUsagePatternSignals(facts, config);
      await userUsagePatternSignalsRepository.upsertLatest(userId, signals, now);
      result.analyzed++;
      if (signals.needsReview) result.needsReview++;
    } catch (error) {
      result.errors++;
      logger.error('Usage pattern signals failed for user', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.log('Usage pattern signals computed', { candidates: candidates.length, ...result });
  return result;
}

export async function handler(_event: never, context: Context) {
  const logger = new Logger().withMetadata({
    requestId: context.awsRequestId ?? randomUUID(),
    functionName: context.functionName,
    stage: Resource.App.stage,
  });
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
  return runUsagePatternSignals({ logger });
}
