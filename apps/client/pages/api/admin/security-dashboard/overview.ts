import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { Resource } from 'sst';
import { securityDashboardSnapshotRepository } from '@bike4mind/database';
import { computeCategoryScoreAndCounts, computeDeterministicStatus } from '@server/security/securityDashboardScoring';

export type SecurityCheckStatus = 'pass' | 'warning' | 'fail' | 'disabled';

export type SecurityCheckId = 'web' | 'code' | 'packages' | 'secrets' | 'cloud' | 'waf';

export interface SecurityCheckSummary {
  id: SecurityCheckId;
  label: string;
  status: SecurityCheckStatus;
  enabled: boolean;
  score: number | null; // 0-100, higher is better
  summary: string;
  severityCounts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  lastCheckedAt: string | null;
}

export interface SecurityDashboardOverviewResponse {
  overallScore: number;
  totalChecks: number;
  passedChecks: number;
  lastUpdated: string;
  nextScanInMinutes: number | null;
  checks: SecurityCheckSummary[];
}

/**
 * Admin Security Dashboard Overview API.
 * Aggregates the latest scan snapshots (web/code/packages/secrets/cloud/waf) into a single overview.
 */
const handler = baseApi().get(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const now = new Date();

  const stage = Resource.App.stage;

  const computeRemainingMinutes = (checkedAt: Date | null | undefined): number | null => {
    if (!checkedAt) return null;
    const last = new Date(checkedAt).getTime();
    if (Number.isNaN(last)) return null;
    const windowMs = 24 * 60 * 60 * 1000;
    const remainingMs = windowMs - (Date.now() - last);
    if (remainingMs <= 0) return 0;
    return Math.ceil(remainingMs / (60 * 1000));
  };

  // Prefer OWASP ZAP-backed scans when available, falling back to legacy 'web' data.
  const webSnapshotOwasp = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'web-owasp');
  const webSnapshot =
    webSnapshotOwasp ?? (await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'web')); // backwards compatibility

  const codeSnapshot = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'code-semgrep');

  const packagesSnapshot = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'packages');

  const secretsSnapshot = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'secrets');

  const cloudSnapshot = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'cloud');

  // WAF is optional; if no snapshot exists yet, present it as disabled.
  const wafSnapshot = await securityDashboardSnapshotRepository.findLatestByStageAndScanType(stage, 'waf');

  const makeCheckFromSnapshot = (
    id: SecurityCheckId,
    label: string,
    snapshot: {
      status: 'pass' | 'warning' | 'fail';
      score: number;
      summary: string;
      findings?: Array<{ severity?: string | null | undefined }>;
      checkedAt: Date;
    } | null,
    options?: { enabledWhenMissing?: boolean; missingSummary?: string; missingStatus?: SecurityCheckStatus }
  ): SecurityCheckSummary => {
    if (!snapshot) {
      const enabled = options?.enabledWhenMissing ?? true;
      return {
        id,
        label,
        enabled,
        status: options?.missingStatus ?? (enabled ? 'warning' : 'disabled'),
        score: null,
        summary: options?.missingSummary ?? (enabled ? 'No scan has been recorded yet for this stage.' : 'Disabled.'),
        severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
        lastCheckedAt: null,
      };
    }

    const { score, counts } = computeCategoryScoreAndCounts(
      id,
      (snapshot.findings ?? []) as unknown as Array<{
        severity?: string | null | undefined;
        metadata?: Record<string, unknown>;
        id?: string;
        title?: string;
      }>
    );
    const status = computeDeterministicStatus(counts, score);

    return {
      id,
      label,
      enabled: true,
      status,
      score,
      summary: snapshot.summary,
      severityCounts: counts,
      lastCheckedAt: snapshot.checkedAt.toISOString(),
    };
  };

  const checks: SecurityCheckSummary[] = [
    makeCheckFromSnapshot('web', 'Website Security', webSnapshot),
    makeCheckFromSnapshot('code', 'Code Analysis', codeSnapshot),
    makeCheckFromSnapshot('packages', 'Packages', packagesSnapshot),
    makeCheckFromSnapshot('secrets', 'Secrets Protection', secretsSnapshot),
    makeCheckFromSnapshot('cloud', 'Cloud Security', cloudSnapshot),
    makeCheckFromSnapshot('waf', 'Firewall / WAF', wafSnapshot, {
      enabledWhenMissing: false,
      missingStatus: 'disabled',
      missingSummary: 'Disabled for this stage.',
    }),
  ];

  const enabledChecks = checks.filter(c => c.enabled && typeof c.score === 'number');
  const totalChecks = checks.length;
  const passedChecks = checks.filter(check => check.status === 'pass').length;
  const overallScore = Math.round(
    enabledChecks.reduce((sum, check) => sum + (check.score ?? 0), 0) / (enabledChecks.length || 1)
  );

  const remainingMinutes = enabledChecks
    .map(c => computeRemainingMinutes(c.lastCheckedAt ? new Date(c.lastCheckedAt) : null))
    .filter((v): v is number => typeof v === 'number');
  const nextScanInMinutes = remainingMinutes.length ? Math.min(...remainingMinutes) : null;

  const response: SecurityDashboardOverviewResponse = {
    overallScore,
    totalChecks,
    passedChecks,
    lastUpdated: now.toISOString(),
    nextScanInMinutes,
    checks,
  };

  return res.status(200).json(response);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
