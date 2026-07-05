/**
 * WAF policy translation.
 *
 * Stage-specific source files in infra/waf/:
 *   - bike4mind-api-protection-prod.json  → production stage
 *   - bike4mind-api-protection-dev.json   → dev/staging + all PR preview stages
 *
 * The files are intentionally separate. The dev file carries a 10,000 req/5min rate limit
 * raised by PR #7514 to prevent Cypress CI from tripping the WAF during E2E runs — a
 * staging-only accommodation that must never ship to production (which uses 2,000 req/5min).
 *
 * IMPORTANT:
 * - IPSet ARNs in the JSON are placeholders replaced at deploy time by buildDevWafRuleJson.
 * - CloudFront-scope WAFv2 resources must be created in us-east-1.
 */
import fs from 'node:fs';
import path from 'node:path';

type JsonWafRule = {
  Name: string;
  Priority: number;
  Statement: Record<string, unknown>;
  Action?: Record<string, unknown>;
  OverrideAction?: Record<string, unknown>;
  VisibilityConfig: {
    SampledRequestsEnabled: boolean;
    CloudWatchMetricsEnabled: boolean;
    MetricName: string;
  };
};

type JsonWafExport = {
  Name: string;
  Description?: string;
  DefaultAction: Record<string, unknown>;
  VisibilityConfig: {
    SampledRequestsEnabled: boolean;
    CloudWatchMetricsEnabled: boolean;
    MetricName: string;
  };
  Rules: JsonWafRule[];
};

export interface WafPolicyOptions {
  /** The ARN of the dev IPSet to use for the emergency-ip-block rule. */
  emergencyIpSetArn: unknown;
  /**
   * Optional suffix for naming (e.g. "pr6391").
   * Used to make WebACL/metric names traceable to a PR deployment.
   */
  nameSuffix?: string;
  /** SST stage name. Controls which WAF JSON file is loaded (prod vs dev). */
  stage: string;
}

export interface WafPolicy {
  name: string;
  description: string;
  scope: 'CLOUDFRONT';
  defaultAction: { allow: {} } | { block: {} };
  visibilityConfig: {
    cloudwatchMetricsEnabled: boolean;
    sampledRequestsEnabled: boolean;
    metricName: string;
  };
}

export function getDevWafMeta(opts: Pick<WafPolicyOptions, 'nameSuffix' | 'stage'>): WafPolicy {
  const exportJson = readExportJson(opts.stage);

  const suffix = opts.nameSuffix ? `-${opts.nameSuffix}` : '-dev';
  const name = `bike4mind-api-protection${suffix}`;
  // Human-readable WAF description; brand externalized (#9310). The resource `name` above is
  // an AWS identity (renaming forces replacement), so it stays as the stable account-tied slug.
  const description = exportJson.Description ?? `API protection for ${process.env.APP_NAME || 'the app'} ${opts.stage}`;

  return {
    name,
    description,
    scope: 'CLOUDFRONT',
    defaultAction: mapDefaultAction(exportJson.DefaultAction),
    visibilityConfig: {
      sampledRequestsEnabled: exportJson.VisibilityConfig.SampledRequestsEnabled,
      cloudwatchMetricsEnabled: exportJson.VisibilityConfig.CloudWatchMetricsEnabled,
      metricName: `bike4mind-api-protection${suffix}`,
    },
  };
}

/**
 * Build raw JSON for `aws.wafv2.WebAcl.ruleJson`.
 *
 * This avoids provider schema limitations around deeply nested statements.
 * We substitute prod IPSet ARNs in the export with the stage-managed IPSet ARN.
 */
export function buildDevWafRuleJson(args: { emergencyIpSetArn: string; stage: string }): string {
  const exportJson = readExportJson(args.stage);

  const rules = exportJson.Rules.map(rule => {
    // Deep clone (rule objects are small)
    const cloned = JSON.parse(JSON.stringify(rule)) as JsonWafRule;

    // Replace any IPSetReferenceStatement ARN with the stage-managed one.
    // (The export contains a prod-account ARN.)
    // any: WAF rule Statement structure is deeply nested and varies by type; casting for IPSet ARN replacement
    const stmt: any = cloned.Statement as any;
    if (stmt?.IPSetReferenceStatement?.ARN) {
      stmt.IPSetReferenceStatement.ARN = args.emergencyIpSetArn;
    }

    return cloned;
  });

  return JSON.stringify(rules);
}

function readExportJson(stage: string): JsonWafExport {
  // SST bundles and evaluates infra in a generated `.sst/platform/...` directory in CI.
  // Use the repository root (process.cwd()) to find the checked-in JSON regardless of bundling location.
  const repoRoot = process.cwd();
  const fileName = stage === 'production' ? 'bike4mind-api-protection-prod.json' : 'bike4mind-api-protection-dev.json';
  const jsonPath = path.join(repoRoot, 'infra', 'waf', fileName);

  const raw = fs.readFileSync(jsonPath, 'utf8');
  return JSON.parse(raw) as JsonWafExport;
}

function mapDefaultAction(action: Record<string, unknown>): { allow: {} } | { block: {} } {
  if ('Allow' in action) return { allow: {} };
  if ('Block' in action) return { block: {} };
  throw new Error('Unsupported DefaultAction in WAF export JSON');
}

// NOTE: We no longer map statements into structured Pulumi objects.
// We use `ruleJson` for WebACL rules to avoid provider schema limitations.

// NOTE: We intentionally do not generate structured `rules` objects anymore.
// Use `ruleJson` (via buildDevWafRuleJson) instead to avoid provider schema issues.
