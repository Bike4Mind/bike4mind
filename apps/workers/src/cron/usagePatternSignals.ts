import { randomUUID } from 'crypto';
import type { Context } from 'aws-lambda';
import mongoose from 'mongoose';
import { Resource } from 'sst';
import { CreditHolderType, settingsMap, type UsagePatternSignalsConfig } from '@bike4mind/common';
import {
  adminSettingsRepository,
  ApiKeyUsageLog,
  connectDB,
  UsageEvent,
  User,
  UserApiKey,
  UserUsagePatternSignals,
  userUsagePatternSignalsRepository,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@bike4mind/server-utils/utils/config';
import { userService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { getActiveSubscriptionsForUser } from '@server/entitlements/activeSubscriptions';

const MS_PER_HOUR = 60 * 60 * 1000;
/** Stop starting new users this long before the Lambda timeout. */
const STOP_MARGIN_MS = 60_000;
/** Route template ApiKeyUsageLog stores for the credit balance read (apps/client/pages/api/v1/credits.ts). */
export const CREDIT_BALANCE_ENDPOINT = '/api/v1/credits';
/**
 * Keys that are the user's own mint: org-billed, agent and product keys and keys minted by a
 * first-party sign-in exchange are not. Shared by the API-share and quick-key reads so they agree.
 */
const PERSONAL_KEY_FILTER = {
  billingOwnerType: { $ne: CreditHolderType.Organization },
  agentId: null,
  productId: null,
  'metadata.createdFrom': { $ne: 'oauth-exchange' },
};

export interface UsagePatternSignalsRunOptions {
  logger?: Logger;
  now?: Date;
  /** Same paid test as the API key trust gate: any active own or org-seat subscription. */
  hasActivePlan?: (userId: string) => Promise<boolean>;
  /** Checked before each user; true ends the run, and the next run starts with the users it missed. */
  shouldStop?: () => boolean;
}

export interface UsagePatternSignalsRunResult {
  status: 'disabled' | 'success' | 'stopped';
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

type Candidate = { _id: mongoose.Types.ObjectId; emailVerifiedAt?: Date | null };

/**
 * Recently active accounts that pay nothing (no admin, ban, purchase or admin trust approval),
 * never-scored first and then least recently scored, so a capped run does not starve anyone.
 * The two distincts range-scan the existing createdAt / timestamp indexes over a short window.
 */
async function findFreeTierCandidates(since: Date): Promise<Candidate[]> {
  const [spenders, apiCallers] = await Promise.all([
    UsageEvent.distinct('userId', { createdAt: { $gte: since }, ownerType: CreditHolderType.User }),
    ApiKeyUsageLog.distinct('userId', { timestamp: { $gte: since } }),
  ]);
  const ids = Array.from(new Set<string>([...spenders, ...apiCallers])).filter(id => mongoose.isValidObjectId(id));
  if (ids.length === 0) return [];
  const [users, scored] = await Promise.all([
    User.find(
      {
        _id: { $in: ids },
        isAdmin: { $ne: true },
        isBanned: { $ne: true },
        apiKeyTrustApproved: { $ne: true },
        lastCreditsPurchasedAt: null,
      },
      { emailVerifiedAt: 1 }
    ).lean<Candidate[]>(),
    UserUsagePatternSignals.find({ userId: { $in: ids } }, { userId: 1, computedAt: 1 }).lean<
      { userId: string; computedAt: Date }[]
    >(),
  ]);
  const lastScored = new Map(scored.map(r => [r.userId, r.computedAt.getTime()]));
  const rank = (u: Candidate) => lastScored.get(String(u._id)) ?? -Infinity;
  return users.sort((a, b) => rank(a) - rank(b) || String(a._id).localeCompare(String(b._id)));
}

async function gatherFacts(
  userId: string,
  emailVerifiedAt: Date | null,
  now: Date,
  config: UsagePatternSignalsConfig
): Promise<userService.UsagePatternFacts> {
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * MS_PER_HOUR);
  const windowStart = daysAgo(config.lookbackDays);
  const readStart = daysAgo(Math.max(config.lookbackDays, config.apiOnlyLookbackDays));
  const apiOnlyStart = daysAgo(config.apiOnlyLookbackDays);
  const [otherKeys, firstKey] = await Promise.all([
    UserApiKey.find({ userId, $nor: [PERSONAL_KEY_FILTER] }, { _id: 1 }).lean<{ _id: mongoose.Types.ObjectId }[]>(),
    UserApiKey.findOne({ userId, ...PERSONAL_KEY_FILTER }, { createdAt: 1 })
      .sort({ createdAt: 1 })
      .lean<{ createdAt?: Date }>(),
  ]);
  const otherKeyIds = otherKeys.map(k => String(k._id));
  // The newest maxEventsPerUser rows via the { userId, createdAt } index, folded to one row per
  // request (a completion can settle several UsageEvent rows).
  const requests = await UsageEvent.aggregate<{ at: Date; api: number; rows: number }>([
    {
      $match: {
        userId,
        createdAt: { $gte: readStart },
        ownerType: CreditHolderType.User,
        feature: { $nin: ['operations', 'embedding'] },
      },
    },
    { $sort: { createdAt: -1 } },
    { $limit: config.maxEventsPerUser },
    {
      $group: {
        _id: '$requestId',
        at: { $min: '$createdAt' },
        // Only known non-personal keys are excluded, so traffic on a since-deleted key still counts.
        api: {
          $max: {
            $cond: [{ $and: [{ $gt: ['$apiKeyId', null] }, { $not: [{ $in: ['$apiKeyId', otherKeyIds] }] }] }, 1, 0],
          },
        },
        rows: { $sum: 1 },
      },
    },
  ]);
  // When the row cap truncated the read, count polls only over the span actually read, so the
  // polls-per-completion ratio compares like with like.
  const truncated = requests.reduce((n, r) => n + r.rows, 0) >= config.maxEventsPerUser;
  const oldestRead = Math.min(...requests.map(r => r.at.getTime()));
  const pollStart = truncated ? new Date(Math.max(windowStart.getTime(), oldestRead)) : windowStart;
  const creditPolls = await ApiKeyUsageLog.countDocuments({
    userId,
    timestamp: { $gte: pollStart },
    endpoint: CREDIT_BALANCE_ENDPOINT,
    method: 'GET',
  });
  const apiOnlyRows = requests.filter(r => r.at >= apiOnlyStart);
  const apiKeyRequests = apiOnlyRows.filter(r => r.api === 1).length;
  const windowRows = requests.filter(r => r.at >= windowStart).sort((a, b) => b.at.getTime() - a.at.getTime());
  return {
    apiKeyRequests,
    sessionRequests: apiOnlyRows.length - apiKeyRequests,
    requestTimes: windowRows.slice(0, config.cadenceSampleSize).map(r => r.at),
    creditPolls,
    completions: windowRows.length,
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
    shouldStop = () => false,
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

  const candidates = await findFreeTierCandidates(new Date(now.getTime() - config.activeWindowHours * MS_PER_HOUR));

  for (const user of candidates) {
    if (result.analyzed >= config.maxUsersPerRun) break;
    if (shouldStop()) {
      result.status = 'stopped';
      break;
    }
    const userId = String(user._id);
    try {
      if (await hasActivePlan(userId)) {
        await userUsagePatternSignalsRepository.markSkipped(userId, 'paid', now);
        result.skippedPaid++;
        continue;
      }
      const facts = await gatherFacts(userId, user.emailVerifiedAt ?? null, now, config);
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
  return runUsagePatternSignals({
    logger,
    shouldStop: () => context.getRemainingTimeInMillis() < STOP_MARGIN_MS,
  });
}
