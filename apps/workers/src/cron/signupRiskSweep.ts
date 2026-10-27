/**
 * Rescores accounts younger than SIGNUP_RISK_WINDOW_DAYS, so signals that build up after signup
 * (first-day spend, a key minted later) reach the score without waiting for another trigger.
 * Accounts an admin already approved or banned are skipped.
 *
 * Not yet scheduled: it needs an sst.aws.Cron entry in infra/cron.ts. Until then, accounts are
 * scored on signup, email verification and API key creation only.
 */

import { Context } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { Logger } from '@bike4mind/observability';
import type { IUserRepository } from '@bike4mind/common';
import {
  adminSettingsRepository,
  connectDB,
  usageEventRepository,
  userApiKeyRepository,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';

export const SIGNUP_RISK_WINDOW_DAYS = 14;
const BATCH_SIZE = 200;

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

/** Pages through the candidates in id order and rescores each; returns how many were rescored. */
export async function sweepSignupRiskScores({
  users,
  refresh,
  now,
}: {
  users: Pick<IUserRepository, 'findRiskScoringCandidateIds'>;
  refresh: (userId: string) => Promise<void>;
  now: Date;
}): Promise<number> {
  const since = new Date(now.getTime() - SIGNUP_RISK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  let afterId: string | undefined;
  let rescored = 0;
  for (;;) {
    const ids = await users.findRiskScoringCandidateIds(since, { afterId, limit: BATCH_SIZE });
    // One at a time: each refresh is a handful of reads, and the sweep has no deadline to race.
    for (const id of ids) {
      await refresh(id);
      rescored += 1;
    }
    if (ids.length < BATCH_SIZE) return rescored;
    afterId = ids[ids.length - 1];
  }
}

export async function handler(_event: unknown, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);

  const rescored = await sweepSignupRiskScores({
    users: userRepository,
    refresh: userId =>
      userService.refreshSignupRiskScore(userId, {
        db: {
          users: userRepository,
          userApiKeys: userApiKeyRepository,
          usageEvents: usageEventRepository,
          adminSettings: adminSettingsRepository,
        },
        logger,
      }),
    now: new Date(),
  });
  logger.log('Signup risk sweep finished', { rescored });
}
