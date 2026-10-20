import type { SecurityDashboardStatus } from '@bike4mind/database';

export type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low';

export interface SecuritySeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export type SecurityCategoryId = 'web' | 'code' | 'packages' | 'secrets' | 'cloud' | 'waf';

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
 * Base severity penalty weights (risk points) used for small, discrete rule sets (e.g. Cloud/WAF).
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

/**
 * Code (Semgrep) scoring: keep critical/high linear, cap medium/low contributions to prevent noisy rulesets
 * from dominating the score.
 */
export const CODE_PENALTIES = {
  critical: 30,
  high: 20,
  mediumEach: 5,
  mediumCap: 30,
  lowEach: 2,
  lowCap: 15,
} as const;

/**
 * Packages scoring: computed on UNIQUE packages (deduped by packageName).
 * If no fix is available, reduce the penalty since remediation may not be immediately possible.
 */
export const PACKAGE_PENALTIES_PER_PACKAGE = {
  critical: 25,
  high: 15,
  medium: 7,
  low: 3,
  noFixFactor: 0.6,
} as const;

/**
 * Secrets scoring: dedupe findings by stable signature and use "binary-ish" posture bands:
 * - any critical/high -> score in [0..40]
 * - only medium/low -> score in [60..85]
 * - none -> 100
 */
export const SECRETS_POSTURE = {
  hiBandMax: 40,
  hiCriticalEach: 15,
  hiHighEach: 8,
  loBandMin: 60,
  loBandMax: 85,
  loMediumEach: 5,
  loLowEach: 2,
} as const;

function log2p1(n: number): number {
  // log2(1 + n) with safe handling for n <= 0
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.log2(1 + n);
}

const severityRank: Record<SecuritySeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function normalizeSeverity(input: unknown): SecuritySeverity | null {
  const sev = typeof input === 'string' ? input.toLowerCase() : '';
  if (sev === 'critical' || sev === 'high' || sev === 'medium' || sev === 'low') return sev;
  return null;
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

export function computeCodeScore(counts: SecuritySeverityCounts): number {
  const { critical, high, medium, low } = counts;
  const mediumPenalty = Math.min(medium * CODE_PENALTIES.mediumEach, CODE_PENALTIES.mediumCap);
  const lowPenalty = Math.min(low * CODE_PENALTIES.lowEach, CODE_PENALTIES.lowCap);
  const riskPoints = critical * CODE_PENALTIES.critical + high * CODE_PENALTIES.high + mediumPenalty + lowPenalty;
  return clampScore(100 - riskPoints);
}

export function computePackagesScoreFromFindings(
  findings: Array<{ severity?: string | null | undefined; metadata?: Record<string, unknown>; id?: string }>
): { score: number; counts: SecuritySeverityCounts } {
  type PackageAgg = { severity: SecuritySeverity; fixAvailable: boolean };
  const packages = new Map<string, PackageAgg>();

  for (const f of findings ?? []) {
    const sev = normalizeSeverity(f?.severity);
    if (!sev) continue;

    const md = (f as any)?.metadata as Record<string, unknown> | undefined;
    const packageName =
      (md && typeof md.packageName === 'string' && md.packageName.trim()) ||
      (typeof (f as any)?.id === 'string' && (f as any).id.trim()) ||
      'unknown';
    const recommendedVersion = md && typeof md.recommendedVersion === 'string' ? md.recommendedVersion.trim() : '';
    const fixAvailable = Boolean(recommendedVersion);

    const existing = packages.get(packageName);
    if (!existing) {
      packages.set(packageName, { severity: sev, fixAvailable });
      continue;
    }

    // Keep the highest severity per package; if any advisory has a fix, mark fixAvailable true.
    if (severityRank[sev] > severityRank[existing.severity]) {
      existing.severity = sev;
    }
    if (fixAvailable) existing.fixAvailable = true;
  }

  const counts = emptyCounts();
  const severityPenalty: Record<SecuritySeverity, number> = {
    critical: PACKAGE_PENALTIES_PER_PACKAGE.critical,
    high: PACKAGE_PENALTIES_PER_PACKAGE.high,
    medium: PACKAGE_PENALTIES_PER_PACKAGE.medium,
    low: PACKAGE_PENALTIES_PER_PACKAGE.low,
  };

  let riskPoints = 0;
  for (const p of packages.values()) {
    counts[p.severity] += 1;
    const fixFactor = p.fixAvailable ? 1 : PACKAGE_PENALTIES_PER_PACKAGE.noFixFactor;
    riskPoints += severityPenalty[p.severity] * fixFactor;
  }

  return { score: clampScore(100 - riskPoints), counts };
}

export function computeSecretsScoreFromFindings(
  findings: Array<{
    severity?: string | null | undefined;
    metadata?: Record<string, unknown>;
    id?: string;
    title?: string;
  }>
): { score: number; counts: SecuritySeverityCounts } {
  type SecretAgg = { severity: SecuritySeverity };
  const secrets = new Map<string, SecretAgg>();

  for (const f of findings ?? []) {
    const sev = normalizeSeverity(f?.severity);
    if (!sev) continue;

    const md = (f as any)?.metadata as Record<string, unknown> | undefined;
    const secretType = md && typeof md.secretType === 'string' ? md.secretType.trim() : '';
    const filePath = md && typeof md.filePath === 'string' ? md.filePath.trim() : '';
    const line = md && typeof md.line === 'number' ? String(md.line) : '';
    const id = typeof (f as any)?.id === 'string' ? (f as any).id.trim() : '';
    const title = typeof (f as any)?.title === 'string' ? (f as any).title.trim() : '';

    // Stable signature (no secret values): secretType + location + rule id; fallback to id/title.
    const signature = [secretType || 'secret', filePath || 'unknown', line || '0', id || title || 'unknown'].join('|');

    const existing = secrets.get(signature);
    if (!existing) {
      secrets.set(signature, { severity: sev });
      continue;
    }
    if (severityRank[sev] > severityRank[existing.severity]) {
      existing.severity = sev;
    }
  }

  const counts = emptyCounts();
  for (const s of secrets.values()) {
    counts[s.severity] += 1;
  }

  // Binary-ish posture model (still deterministic and graded).
  if (counts.critical + counts.high > 0) {
    const raw =
      SECRETS_POSTURE.hiBandMax -
      counts.critical * SECRETS_POSTURE.hiCriticalEach -
      counts.high * SECRETS_POSTURE.hiHighEach;
    return { score: Math.max(0, Math.min(SECRETS_POSTURE.hiBandMax, raw)), counts };
  }

  if (counts.medium + counts.low > 0) {
    const raw =
      SECRETS_POSTURE.loBandMax - counts.medium * SECRETS_POSTURE.loMediumEach - counts.low * SECRETS_POSTURE.loLowEach;
    return { score: Math.max(SECRETS_POSTURE.loBandMin, Math.min(SECRETS_POSTURE.loBandMax, raw)), counts };
  }

  return { score: 100, counts };
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
  if (categoryId === 'code') {
    const counts = countBySeverity(findings);
    return { score: computeCodeScore(counts), counts };
  }
  if (categoryId === 'packages') {
    return computePackagesScoreFromFindings(findings);
  }
  if (categoryId === 'secrets') {
    return computeSecretsScoreFromFindings(findings);
  }
  // cloud + waf
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
