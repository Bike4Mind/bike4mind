/**
 * Hourly shadow sweep for coordinated account campaigns: correlates the last
 * ACCOUNT_CAMPAIGN_WINDOW_HOURS of signups (engine: b4m-core/services/src/userService/accountCampaigns.ts)
 * and records each candidate group as an `accountCampaign` shadow detection for the admin Detections
 * page. Observation only: it never rescores, sets riskScore.reviewState, or touches access, credits or
 * API keys. Off with the shadowDetectionRecordingEnabled setting, like every shadow detector.
 * It then runs the ban-evasion device rule over the same window; that rule hands its detections to
 * the abuse assessment and automated containment, which act only as autoContainmentConfig allows.
 */

import { Context } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { Logger } from '@bike4mind/observability';
import { personalEmailProviders, regionalPersonalEmailProviders } from '@bike4mind/common';
import {
  adminSettingsRepository,
  connectDB,
  findSignupFingerprintClusters,
  loadCampaignScanAccounts,
  loadRecentDeviceLinkAccounts,
  shadowDetectionRepository,
  type CampaignScanRow,
  type RecordCampaignGroupResult,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { truncateIp } from '@bike4mind/server-utils/utils/ip';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';
import { liveDeviceLinkDeps, sweepDeviceLinks } from '@server/security/autoContainment/deviceLink';

export const ACCOUNT_CAMPAIGN_WINDOW_HOURS = 72;
/** Newest signups scanned per run; a busier window is cut and reported as truncated. */
export const ACCOUNT_CAMPAIGN_SCAN_LIMIT = 2_000;
const COMMON_FINGERPRINT_BASELINE_DAYS = 30;
/** A JA4 seen on this many signups over the baseline is a mainstream client, never evidence. */
const COMMON_FINGERPRINT_MIN_SIGNUPS = 50;
const COMMON_FINGERPRINT_LIMIT = 1_000;

const HOUR_MS = 60 * 60 * 1000;
const PERSONAL_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  ...personalEmailProviders,
  ...regionalPersonalEmailProviders,
]);

export function toCampaignAccount(row: CampaignScanRow): userService.CampaignAccount {
  return {
    userId: row.userId,
    signedUpAt: row.createdAt,
    networkPrefix: row.ip ? truncateIp(row.ip) : null,
    asn: row.asn,
    hosting: row.isDatacenter,
    fingerprint: row.ja4,
    mailDomain: userService.signupRegistrableDomain(row.email),
    lifecycle: {
      emailVerifiedAt: row.emailVerifiedAt,
      firstApiKeyAt: row.firstApiKeyAt,
      firstUsageAt: row.firstUsageAt,
    },
  };
}

export type AccountCampaignSweepReport = userService.CampaignScanStats & {
  scanTruncated: boolean;
  recorded: Record<RecordCampaignGroupResult, number>;
  /** Groups whose write threw; the rest of the run still records. */
  failed: number;
};

export async function sweepAccountCampaigns({
  load = loadCampaignScanAccounts,
  commonFingerprints = findSignupFingerprintClusters,
  record = input => shadowDetectionRepository.recordCampaignGroup(input),
  onRecordError = () => undefined,
  now,
}: {
  load?: typeof loadCampaignScanAccounts;
  commonFingerprints?: typeof findSignupFingerprintClusters;
  record?: (input: userService.CampaignShadowDetection) => Promise<RecordCampaignGroupResult>;
  onRecordError?: (error: unknown, group: userService.CampaignShadowDetection) => void;
  now: Date;
}): Promise<AccountCampaignSweepReport> {
  const window = { from: new Date(now.getTime() - ACCOUNT_CAMPAIGN_WINDOW_HOURS * HOUR_MS), to: now };
  const [scan, common] = await Promise.all([
    load({ since: window.from, until: window.to, limit: ACCOUNT_CAMPAIGN_SCAN_LIMIT }),
    commonFingerprints({
      windowStart: new Date(now.getTime() - COMMON_FINGERPRINT_BASELINE_DAYS * 24 * HOUR_MS),
      windowEnd: now,
      minimumSignups: COMMON_FINGERPRINT_MIN_SIGNUPS,
      excludedFingerprints: [],
      limit: COMMON_FINGERPRINT_LIMIT,
    }),
  ]);

  const { groups, stats } = userService.findAccountCampaigns({
    accounts: scan.rows.map(toCampaignAccount),
    window,
    commonFingerprints: new Set(common.map(cluster => cluster.ja4)),
    personalMailDomains: PERSONAL_MAIL_DOMAINS,
    now,
  });

  const recorded: Record<RecordCampaignGroupResult, number> = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  // Sequential: two groups can share a transitive member, and each write reads the record it may update.
  let failed = 0;
  for (const group of groups) {
    const detection = userService.toCampaignShadowDetection(group, ACCOUNT_CAMPAIGN_WINDOW_HOURS * 60);
    try {
      recorded[await record(detection)] += 1;
    } catch (error) {
      failed += 1;
      onRecordError(error, detection);
    }
  }
  return { ...stats, scanTruncated: scan.truncated, recorded, failed };
}

export async function handler(_event: unknown, context: Context) {
  const logger = new Logger().withMetadata({
    requestId: context.awsRequestId ?? randomUUID(),
    functionName: context.functionName,
    stage: Resource.App.stage,
  });
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);

  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { skipCache: true, names: ['shadowDetectionRecordingEnabled'] }
  );
  if (!getSettingsValue('shadowDetectionRecordingEnabled', settings, true)) {
    logger.log('Account campaign sweep skipped: shadow detection recording is off');
    return;
  }

  const report = await sweepAccountCampaigns({
    now: new Date(),
    onRecordError: (error, group) =>
      logger.error('Account campaign group failed to record', { userIds: group.userIds, error: String(error) }),
  });
  logger.log('Account campaign sweep finished', report);

  // The ban-evasion device rule's catch-up pass (security/autoContainment/deviceLink.ts): a device first
  // seen at a sign-in after the signup, or a signup whose immediate check failed.
  const deviceLinks = await sweepDeviceLinks({
    ...liveDeviceLinkDeps(logger),
    loadRecent: loadRecentDeviceLinkAccounts,
    onError: (userId, error) =>
      logger.error('Device-link detection failed to record', { userId, error: String(error) }),
  });
  logger.log('Device-link sweep finished', deviceLinks);

  // Thrown after the whole run so one bad group cannot starve the rest, but the invocation still fails.
  if (report.failed > 0) throw new Error(`Account campaign sweep failed to record ${report.failed} group(s)`);
  if (deviceLinks.failed > 0) throw new Error(`Device-link sweep failed to record ${deviceLinks.failed} account(s)`);
}
