import {
  securityDashboardSnapshotRepository,
  type ISecurityDashboardSnapshotDocument,
  type SecurityDashboardStatus,
} from '@bike4mind/database';
import { Resource } from 'sst';
import { resolveStage } from './resolveStage';
import { resolveRouterDistributionId } from './wafSharedHelpers';

type WafSeverity = 'critical' | 'high' | 'medium' | 'low';

interface WafRuleResult {
  id: string;
  title: string;
  severity: WafSeverity;
  passed: boolean;
  description: string;
  recommendation?: string;
  documentationUrl?: string;
}

function mapStageToEnv(stage: string): 'dev' | 'prod' {
  // Treat all non-production stages (including PR stages) as dev for WAF purposes.
  if (stage === 'production') {
    return 'prod';
  }
  return 'dev';
}

export function computeStatusAndScore(counts: { critical: number; high: number; medium: number; low: number }): {
  status: SecurityDashboardStatus;
  score: number;
  summary: string;
} {
  const { critical, high, medium, low } = counts;

  let score = 100;
  score -= critical * 30;
  score -= high * 20;
  score -= medium * 10;
  score -= low * 5;

  const clampedScore = Math.max(0, Math.min(100, score));

  let status: SecurityDashboardStatus = 'pass';
  if (critical > 0 || high > 0) {
    status = 'fail';
  } else if (medium > 0 || low > 0) {
    status = 'warning';
  }

  const parts: string[] = [];
  if (critical === 0 && high === 0 && medium === 0 && low === 0) {
    parts.push('No WAF configuration issues detected in the latest scan.');
  } else {
    const pieces: string[] = [];
    if (critical) pieces.push(`${critical} critical`);
    if (high) pieces.push(`${high} high`);
    if (medium) pieces.push(`${medium} medium`);
    if (low) pieces.push(`${low} low`);
    parts.push(`${pieces.join(', ')} WAF configuration issues detected in the latest scan.`);
  }

  return { status, score: clampedScore, summary: parts.join(' ') };
}

function parseListFromEnv(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

async function evaluateWafConfiguration(stage: string): Promise<{
  rules: WafRuleResult[];
  targetUrl: string | null;
  context: {
    env: 'dev' | 'prod';
    explicitWebAcls: string[];
    distributions: string[];
    discoverySource: 'none' | 'secrets' | 'tags' | 'secrets+tags';
  };
}> {
  const env = mapStageToEnv(stage);

  const wafResources = Resource as typeof Resource & {
    SECOPS_WAF_WEBACL_ARN?: { value: string };
    SECOPS_WAF_DISTRIBUTION_ID?: { value: string };
  };

  const webAclSecret = wafResources.SECOPS_WAF_WEBACL_ARN?.value || process.env.SECOPS_WAF_WEBACL_ARN || '';
  const distributionSecret =
    wafResources.SECOPS_WAF_DISTRIBUTION_ID?.value || process.env.SECOPS_WAF_DISTRIBUTION_ID || '';

  const explicitWebAcls = parseListFromEnv(webAclSecret);
  const explicitDistributions = parseListFromEnv(distributionSecret);

  const rules: WafRuleResult[] = [];

  const discoverySources: Array<'secrets' | 'tags'> = [];

  if (explicitWebAcls.length > 0 || explicitDistributions.length > 0) {
    discoverySources.push('secrets');
  }

  let effectiveDistributions = explicitDistributions;

  if (explicitWebAcls.length === 0 && explicitDistributions.length === 0) {
    let routerDistributionId: string | null = null;
    try {
      routerDistributionId = resolveRouterDistributionId();
    } catch {
      // Not available in this environment - handled as a scan finding below
    }

    if (!routerDistributionId) {
      rules.push({
        id: 'waf-no-resources-discovered',
        title: 'No WAF resources discovered for this environment',
        severity: 'medium',
        passed: false,
        description:
          `No explicit WAF WebACL ARNs or CloudFront distribution IDs are configured for env "${env}", and ` +
          'the Router CloudFront distribution could not be resolved from SST Resource link. ' +
          'Verify that WAF is configured for your public endpoints.',
        recommendation:
          'Configure WAF WebACLs and attach them to your CloudFront distributions. ' +
          'Ensure the Router resource is properly linked to the frontend Lambda in infra/web.ts.',
        documentationUrl: 'https://docs.aws.amazon.com/waf/latest/developerguide/aws-waf-developer-guide.html',
      });
    } else {
      effectiveDistributions = [routerDistributionId];
      discoverySources.push('tags');

      rules.push({
        id: 'waf-cloudfront-distributions-discovered',
        title: 'Router CloudFront distribution resolved from SST Resource link',
        severity: 'low',
        passed: true,
        description:
          `Resolved Router CloudFront distribution (${routerDistributionId}) for env "${env}" ` +
          'from SST Resource link. This distribution is treated as the primary public entry point for WAF evaluation.',
        recommendation:
          'Ensure the Router distribution is associated with the expected WebACL and that default actions ' +
          'and rule priorities are configured correctly.',
        documentationUrl:
          'https://docs.aws.amazon.com/waf/latest/developerguide/web-acl-associating-aws-resources.html',
      });
    }
  }

  if (explicitWebAcls.length > 0) {
    rules.push({
      id: 'waf-webacl-configured',
      title: 'WAF WebACLs configured for this environment',
      severity: 'low',
      passed: true,
      description:
        `One or more WAF WebACL ARNs are explicitly configured for env "${env}". ` +
        'The Cloud Firewall scan will treat these WebACLs as the primary protection layer for your public endpoints.',
      recommendation:
        'Periodically review WAF rule sets (OWASP, bot control, rate limiting) to ensure they align with your current threat model.',
      documentationUrl: 'https://docs.aws.amazon.com/waf/latest/developerguide/web-acl-testing-and-tuning.html',
    });
  }

  if (effectiveDistributions.length > 0) {
    rules.push({
      id: 'waf-cloudfront-distributions-configured',
      title: 'CloudFront distributions mapped to WAF',
      severity: 'low',
      passed: true,
      description:
        `One or more CloudFront distribution IDs are configured for env "${env}". ` +
        'This indicates that your public traffic is fronted by CloudFront and can be protected by WAF.',
      recommendation:
        'Ensure that the configured distributions are attached to the expected WebACLs and that default actions and rule priorities are configured correctly.',
      documentationUrl: 'https://docs.aws.amazon.com/waf/latest/developerguide/web-acl-associating-aws-resources.html',
    });
  }

  const targetUrl =
    effectiveDistributions.length > 0
      ? `cloudfront:${effectiveDistributions[0]}`
      : explicitWebAcls.length > 0
        ? explicitWebAcls[0]
        : null;

  const discoverySource: 'none' | 'secrets' | 'tags' | 'secrets+tags' =
    discoverySources.length === 0 ? 'none' : discoverySources.length === 1 ? discoverySources[0] : 'secrets+tags';

  return {
    rules,
    targetUrl,
    context: {
      env,
      explicitWebAcls,
      distributions: effectiveDistributions,
      discoverySource,
    },
  };
}

export const handler = async (): Promise<void> => {
  try {
    const stage = resolveStage();

    const { rules, targetUrl, context } = await evaluateWafConfiguration(stage);

    const failedRules = rules.filter(rule => !rule.passed);

    const counts = failedRules.reduce(
      (acc, rule) => {
        if (rule.severity === 'critical') acc.critical += 1;
        else if (rule.severity === 'high') acc.high += 1;
        else if (rule.severity === 'medium') acc.medium += 1;
        else acc.low += 1;
        return acc;
      },
      { critical: 0, high: 0, medium: 0, low: 0 }
    );

    const { status, score, summary } = computeStatusAndScore(counts);

    const issueFindings: ISecurityDashboardSnapshotDocument['findings'] = rules
      .filter(rule => !rule.passed)
      .map(rule => ({
        id: rule.id,
        title: rule.title,
        severity: rule.severity,
        description: rule.description,
        recommendation: rule.recommendation,
        documentationUrl: rule.documentationUrl,
      }));

    const summaryDescriptionParts: string[] = [];
    if (context.explicitWebAcls.length > 0) {
      summaryDescriptionParts.push(
        `${context.explicitWebAcls.length} WebACL ARN${context.explicitWebAcls.length === 1 ? '' : 's'} configured via secrets.`
      );
    }
    if (context.distributions.length > 0) {
      summaryDescriptionParts.push(
        `${context.distributions.length} CloudFront distribution ID${context.distributions.length === 1 ? '' : 's'} evaluated.`
      );
    }
    if (summaryDescriptionParts.length === 0) {
      summaryDescriptionParts.push(
        'No explicit WebACL ARNs or CloudFront distribution IDs were discovered for this environment.'
      );
    }

    const summaryFinding: ISecurityDashboardSnapshotDocument['findings'][number] = {
      id: 'waf-configuration-summary',
      title: 'Firewall / WAF configuration scanned',
      severity: 'low',
      description: summaryDescriptionParts.join(' '),
      metadata: {
        informational: true,
        env: context.env,
        webAcls: context.explicitWebAcls,
        distributions: context.distributions,
        discoverySource: context.discoverySource,
      },
    };

    const findings: ISecurityDashboardSnapshotDocument['findings'] = [...issueFindings, summaryFinding];

    const checkedAt = new Date();

    const snapshotInput: Omit<ISecurityDashboardSnapshotDocument, 'id' | 'createdAt' | 'updatedAt'> = {
      stage,
      scanType: 'waf',
      targetUrl: targetUrl || `env:${mapStageToEnv(stage)}`,
      status,
      score,
      summary,
      findings,
      checkedAt,
    };

    await securityDashboardSnapshotRepository.create(snapshotInput);
  } catch (error) {
    console.error('WAF security scan failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
};
