import { COMPLETION_SYNCHRONY_POLICY_VERSION, type ShadowDetectionItem } from '@bike4mind/common';
import {
  loadCompletionCohortExposure,
  loadCompletionSynchronyEvents,
  shadowDetectionRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';

export async function sweepCompletionSynchrony({
  now,
  load = loadCompletionSynchronyEvents,
  record = (input: Parameters<typeof shadowDetectionRepository.recordCompletionSynchrony>[0]) =>
    shadowDetectionRepository.recordCompletionSynchrony(input),
  onRecordError = () => undefined,
  loadExposure = loadCompletionCohortExposure,
}: {
  now: Date;
  load?: typeof loadCompletionSynchronyEvents;
  record?: typeof shadowDetectionRepository.recordCompletionSynchrony;
  onRecordError?: (error: unknown) => void;
  loadExposure?: typeof loadCompletionCohortExposure;
}) {
  const scan = await load(now);
  const result = userService.findCompletionSynchrony(scan.events);
  let exposure: Awaited<ReturnType<typeof loadExposure>> | undefined;
  if (result.patterns.length) {
    try {
      exposure = await loadExposure(
        result.patterns.flatMap(pattern => pattern.userIds),
        now
      );
    } catch (error) {
      onRecordError(error);
    }
  }
  const recorded = { created: 0, updated: 0, unchanged: 0 };
  let failed = 0;
  for (const pattern of result.patterns) {
    const { userIds, ...metrics } = pattern;
    const members = new Set(userIds);
    const creditExposure = exposure?.accounts
      .filter(account => members.has(account.userId))
      .reduce(
        (sum, account) => ({
          scope: sum.scope,
          scanTruncated: sum.scanTruncated,
          creditsCharged: sum.creditsCharged + account.creditsCharged,
          grantFundedCredits: sum.grantFundedCredits + account.grantFundedCredits,
          unknownFundingCredits: sum.unknownFundingCredits + account.unknownFundingCredits,
        }),
        {
          scope: 'cohort_completion_api_24h' as const,
          scanTruncated: exposure?.truncated ?? false,
          creditsCharged: 0,
          grantFundedCredits: 0,
          unknownFundingCredits: 0,
        }
      );
    const input: Omit<ShadowDetectionItem, 'id' | 'verdict' | 'verdicts' | 'revision'> = {
      detector: 'completionSynchrony',
      policyVersion: COMPLETION_SYNCHRONY_POLICY_VERSION,
      wouldAction: 'none',
      userIds,
      detectedAt: now,
      group: null,
      network: null,
      payment: null,
      windowMinutes: 24 * 60,
      summary: `${userIds.length} accounts shared ${pattern.bursts} request-start bursts and ${pattern.synchronizedModelSwitches} requested-model switches; coordination only, review required`,
      completionSynchrony: {
        ...metrics,
        scannedAt: now,
        ...(creditExposure ? { creditExposure } : {}),
        source: 'api_key_request_starts',
        windowHours: 24,
        eventsScanned: scan.rowsScanned,
        legacyRows: scan.legacyRows,
        scanTruncated: scan.truncated || result.truncated,
      },
      signals: [
        { key: 'synchronizedBursts', label: 'Repeated request-start bursts', observed: pattern.bursts, threshold: 3 },
        {
          key: 'synchronizedModelSwitches',
          label: 'Requested-model changes between matched bursts',
          observed: pattern.synchronizedModelSwitches,
          threshold: null,
        },
        {
          key: 'dailyCapRejectedRequests',
          label: 'Daily-cap rejections in matched bursts',
          observed: pattern.dailyCapRejectedRequests,
          threshold: null,
        },
      ],
    };
    try {
      recorded[await record(input)]++;
    } catch (error) {
      failed++;
      onRecordError(error);
    }
  }
  return {
    exposureFailed: result.patterns.length > 0 && !exposure,
    rowsScanned: scan.rowsScanned,
    legacyRows: scan.legacyRows,
    scanTruncated: scan.truncated || result.truncated,
    patterns: result.patterns.length,
    recorded,
    failed,
  };
}
