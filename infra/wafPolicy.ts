/**
 * WAF policy translation for the stage-owned ACLs (dev, staging and PR preview stages).
 *
 * The policy is bike4mind-api-protection-dev.json, read from the policy directory (see
 * resolveWafPolicyDir). The file committed in infra/waf/ is the sample policy that ships with the
 * product. A deployment may set WAF_POLICY_DIR to its own directory holding the same file name.
 *
 * The production ACL is not built here; see wafAssociation.ts.
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
  /** SST stage name. Used for the default description. */
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
  const exportJson = readExportJson();

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
export function buildDevWafRuleJson(args: {
  emergencyIpSetArn: string;
  rateExemptIpSetArn: string;
  stage: string;
}): string {
  const exportJson = readExportJson();

  const rules = exportJson.Rules.map(rule => {
    // Deep clone (rule objects are small)
    const cloned = JSON.parse(JSON.stringify(rule)) as JsonWafRule;

    // Replace any IPSetReferenceStatement ARN with the stage-managed one. The emergency set is the
    // whole statement of its rule; the rate-exempt set sits inside rate rule scope-downs.
    const stmt = cloned.Statement;
    const ipSetReference = stmt.IPSetReferenceStatement;
    if (isStatementObject(ipSetReference) && typeof ipSetReference.ARN === 'string') {
      ipSetReference.ARN = args.emergencyIpSetArn;
    }
    replaceRateExemptArn(stmt, args.rateExemptIpSetArn);

    return cloned;
  });

  return JSON.stringify(rules);
}

/** ARN placeholder in the policy files for the IP set that rate rules do not count. */
export const RATE_EXEMPT_IPSET_PLACEHOLDER = 'PLACEHOLDER_RATE_EXEMPT_IPSET_ARN';

function isStatementObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function replaceRateExemptArn(node: unknown, arn: string): void {
  if (Array.isArray(node)) {
    for (const child of node) replaceRateExemptArn(child, arn);
    return;
  }
  if (!isStatementObject(node)) return;
  const reference = node.IPSetReferenceStatement;
  if (isStatementObject(reference) && reference.ARN === RATE_EXEMPT_IPSET_PLACEHOLDER) {
    reference.ARN = arn;
  }
  for (const value of Object.values(node)) replaceRateExemptArn(value, arn);
}

const BLOCKED_IP_PLACEHOLDER = '192.0.2.0/32';

/**
 * Parses a comma-separated list of IPv4 addresses or IPv4 CIDRs into WAF IPSet entries.
 * Bare addresses get /32, duplicates collapse in order, and an empty list yields a TEST-NET
 * placeholder because WAF requires at least one address. Throws on anything else, including a /0
 * prefix, which the WAF API rejects at deploy time. `varName` only labels the error.
 */
export function parseWafBlockedIps(raw: string | undefined, varName = 'WAF_BLOCKED_IPS'): string[] {
  const octet = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
  const pattern = new RegExp(`^${octet}(?:\\.${octet}){3}(?:/(?:3[0-2]|[12]\\d|[1-9]))?$`);

  const entries = (raw ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
    .map(entry => {
      if (!pattern.test(entry)) {
        throw new Error(`${varName} entry "${entry}" is not an IPv4 address or IPv4 CIDR`);
      }
      return entry.includes('/') ? entry : `${entry}/32`;
    });

  const unique = [...new Set(entries)];
  return unique.length > 0 ? unique : [BLOCKED_IP_PLACEHOLDER];
}

/**
 * Directory holding the policy file: WAF_POLICY_DIR (absolute, or relative to cwd)
 * when set, otherwise the committed sample in <cwd>/infra/waf.
 */
export function resolveWafPolicyDir(env: NodeJS.ProcessEnv): string {
  // SST bundles and evaluates infra in a generated `.sst/platform/...` directory in CI, so resolve
  // against the repository root (process.cwd()) rather than this file's location.
  const repoRoot = process.cwd();
  const override = env.WAF_POLICY_DIR?.trim();
  return override ? path.resolve(repoRoot, override) : path.join(repoRoot, 'infra', 'waf');
}

function readExportJson(): JsonWafExport {
  const fileName = 'bike4mind-api-protection-dev.json';
  // Read spelled out so scripts/check-deploy-contract.py sees it as a deploy-time env.
  const jsonPath = path.join(resolveWafPolicyDir({ WAF_POLICY_DIR: process.env.WAF_POLICY_DIR }), fileName);

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
