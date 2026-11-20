import type { SecurityDashboardStatus } from '@bike4mind/database';

export type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low';

export interface SecuritySeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export type SecurityCategoryId = 'web' | 'cloud';

export const emptyCounts = (): SecuritySeverityCounts => ({ critical: 0, high: 0, medium: 0, low: 0 });

export function countBySeverity(findings: Array<{ severity?: string | null | undefined }>): SecuritySeverityCounts {
  const counts = emptyCounts();
  for (const f of findings ?? []) {
    const sev = (f?.severity ?? '').toLowerCase();
    if (sev === 'critical') counts.critical += 1;
    else if (sev === 'high') counts.high += 1;
    else if (sev === 'medium') counts.medium += 1;
    else if (sev === 'low') counts.low += 1;
  }
  return counts;
}

export function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

/**
 * Base severity penalty weights (risk points) used for small, discrete rule sets (e.g. Cloud).
 * These values are intentionally large enough that any critical/high finding heavily impacts the score.
 */
export const SEVERITY_PENALTIES_LINEAR = {
  critical: 30,
  high: 20,
  medium: 10,
  low: 5,
} as const;

/**
 * Web (OWASP ZAP) scoring: keep critical/high linear, dampen medium/low with log2(1+n)
 * to avoid large scans bottoming out at 0 purely due to volume of low/medium alerts.
 */
export const WEB_PENALTIES = {
  critical: 30,
  high: 20,
  mediumLog2Weight: 10,
  lowLog2Weight: 5,
} as const;

function log2p1(n: number): number {
  // log2(1 + n) with safe handling for n <= 0
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.log2(1 + n);
}

/**
 * Deterministic scoring model used across all security dashboard categories.
 *
 * score = 100 - (critical*30) - (high*20) - (medium*10) - (low*5)
 */
export function computeDeterministicScore(counts: SecuritySeverityCounts): number {
  const { critical, high, medium, low } = counts;
  const raw =
    100 -
    critical * SEVERITY_PENALTIES_LINEAR.critical -
    high * SEVERITY_PENALTIES_LINEAR.high -
    medium * SEVERITY_PENALTIES_LINEAR.medium -
    low * SEVERITY_PENALTIES_LINEAR.low;
  return clampScore(raw);
}

export function computeWebsiteScore(counts: SecuritySeverityCounts): number {
  const { critical, high, medium, low } = counts;
  const riskPoints =
    critical * WEB_PENALTIES.critical +
    high * WEB_PENALTIES.high +
    WEB_PENALTIES.mediumLog2Weight * log2p1(medium) +
    WEB_PENALTIES.lowLog2Weight * log2p1(low);
  return clampScore(100 - riskPoints);
}

export function computeCategoryScoreAndCounts(
  categoryId: SecurityCategoryId,
  findings: Array<{
    severity?: string | null | undefined;
    metadata?: Record<string, unknown>;
    id?: string;
    title?: string;
  }>
): { score: number; counts: SecuritySeverityCounts } {
  if (categoryId === 'web') {
    const counts = countBySeverity(findings);
    return { score: computeWebsiteScore(counts), counts };
  }
  const counts = countBySeverity(findings);
  return { score: computeDeterministicScore(counts), counts };
}

/**
 * Deterministic status model used across all security dashboard categories.
 *
 * - fail: critical>0 OR high>0 OR score<50
 * - warning: (medium+low)>0 OR (50<=score<85)
 * - pass: score>=85 AND allCounts==0
 */
export function computeDeterministicStatus(counts: SecuritySeverityCounts, score: number): SecurityDashboardStatus {
  const { critical, high, medium, low } = counts;

  if (critical > 0 || high > 0 || score < 50) return 'fail';
  if (medium + low > 0 || (score >= 50 && score < 85)) return 'warning';
  return 'pass';
}

export function describeCounts(
  counts: SecuritySeverityCounts,
  nounPhrase: string,
  options?: { noneDetectedSentence?: string }
): string {
  const { critical, high, medium, low } = counts;
  if (critical === 0 && high === 0 && medium === 0 && low === 0) {
    return options?.noneDetectedSentence ?? `No ${nounPhrase} detected in the latest scan.`;
  }

  const pieces: string[] = [];
  if (critical) pieces.push(`${critical} critical`);
  if (high) pieces.push(`${high} high`);
  if (medium) pieces.push(`${medium} medium`);
  if (low) pieces.push(`${low} low`);
  return `${pieces.join(', ')} ${nounPhrase} in the latest scan.`;
}

export function computeStatusScoreAndSummary(
  counts: SecuritySeverityCounts,
  nounPhrase: string,
  options?: { noneDetectedSentence?: string }
): { status: SecurityDashboardStatus; score: number; summary: string } {
  const score = computeDeterministicScore(counts);
  const status = computeDeterministicStatus(counts, score);
  const summary = describeCounts(counts, nounPhrase, options);
  return { status, score, summary };
}
