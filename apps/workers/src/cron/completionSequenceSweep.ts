import { sweepCompletionSynchrony } from './completionSynchronySweep';
import type { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import {
  COMPLETION_SEQUENCE_POLICY_VERSION,
  COMPLETION_SEQUENCE_WINDOW_HOURS,
  type ShadowDetectionItem,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  connectDB,
  loadCompletionSequenceEvents,
  shadowDetectionRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';

export async function sweepCompletionSequences({
  now,
  onRecordError = () => undefined,
  load = loadCompletionSequenceEvents,
  record = (input: Parameters<typeof shadowDetectionRepository.recordCompletionSequence>[0]) =>
    shadowDetectionRepository.recordCompletionSequence(input),
}: {
  now: Date;
  onRecordError?: (error: unknown) => void;
  load?: typeof loadCompletionSequenceEvents;
  record?: typeof shadowDetectionRepository.recordCompletionSequence;
}) {
  const scan = await load(now);
  const result = userService.findCompletionSequences(scan.events);
  const recorded = { created: 0, updated: 0, unchanged: 0 };
  let failed = 0;
  for (const pattern of result.patterns) {
    const { userIds, ...metrics } = pattern;
    const input: Omit<ShadowDetectionItem, 'id' | 'verdict' | 'verdicts' | 'revision'> = {
      detector: 'completionSequence',
      policyVersion: COMPLETION_SEQUENCE_POLICY_VERSION,
      wouldAction: 'none',
      userIds,
      detectedAt: now,
      group: null,
      network: null,
      payment: null,
      summary: `${userIds.length} accounts repeated the same completion settlement order across ${pattern.rounds} rounds; coordination only, review required`,
      windowMinutes: COMPLETION_SEQUENCE_WINDOW_HOURS * 60,
      completionSequence: {
        ...metrics,
        source: 'completion_usage_ledger',
        windowHours: COMPLETION_SEQUENCE_WINDOW_HOURS,
        eventsScanned: scan.rowsScanned,
        scanTruncated: scan.truncated || result.truncated,
      },
      signals: [
        {
          key: 'orderedAccounts',
          label: 'Accounts in repeated settlement order',
          observed: userIds.length,
          threshold: 3,
        },
        { key: 'repeatedRounds', label: 'Disjoint observed rounds', observed: pattern.rounds, threshold: 2 },
        {
          key: 'scanTruncated',
          label: 'Observation coverage capped',
          observed: Number(scan.truncated || result.truncated),
          threshold: null,
        },
      ],
    };
    try {
      recorded[await record(input)] += 1;
    } catch (error) {
      failed += 1;
      onRecordError(error);
    }
  }
  return {
    rowsScanned: scan.rowsScanned,
    accountsScanned: scan.accountsScanned,
    scanTruncated: scan.truncated || result.truncated,
    ambiguousTimestamps: result.ambiguousTimestamps,
    patterns: result.patterns.length,
    recorded,
    failed,
  };
}

export async function handler(_event: unknown, context: Context) {
  const logger = new Logger().withMetadata({
    requestId: context.awsRequestId,
    functionName: context.functionName,
    stage: Resource.App.stage,
  });
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { skipCache: true, names: ['shadowDetectionRecordingEnabled'] }
  );
  if (!getSettingsValue('shadowDetectionRecordingEnabled', settings, true)) return;
  const report = await sweepCompletionSequences({
    now: new Date(),
    onRecordError: error => logger.error('Completion sequence observation failed to record', { error: String(error) }),
  });
  logger.log('Completion sequence observation sweep finished', report);
  const synchrony = await sweepCompletionSynchrony({
    now: new Date(),
    onRecordError: error => logger.error('Synchronized completion evidence operation failed', { error: String(error) }),
  });
  logger.log('Synchronized completion observation sweep finished', synchrony);
  if (synchrony.failed > 0) throw new Error(`Synchrony sweep failed to record ${synchrony.failed} observation(s)`);
  if (report.failed > 0) throw new Error(`Completion sequence sweep failed to record ${report.failed} observation(s)`);
}
