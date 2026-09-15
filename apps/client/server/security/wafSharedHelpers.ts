/**
 * Shared helpers and constants for WAF traffic and logs insights.
 *
 * These utilities are extracted from wafTraffic.ts and wafLogsInsights.ts to eliminate DRY violations.
 */

import { Resource } from 'sst';
import { NotFoundError } from '@server/utils/errors';

export type WafTrafficRange = '1h' | '24h' | '7d';

/** Explicit start/end window - user-supplied custom date range. */
export interface WafCustomRange {
  /** ISO 8601 string. */
  start: string;
  /** ISO 8601 string. */
  end: string;
}

/** Union accepted everywhere a range is needed. */
export type WafRangeInput = WafTrafficRange | WafCustomRange;

export function isCustomRange(range: WafRangeInput): range is WafCustomRange {
  return typeof range === 'object';
}

/**
 * Time range to milliseconds mapping.
 * Used by both traffic metrics and logs insights queries.
 */
export const RANGE_MS: Record<WafTrafficRange, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

/**
 * Resolve an absolute { startTime, endTime } window from any range input.
 * For preset ranges the window ends at now; for custom ranges the caller-supplied timestamps are used.
 */
export function resolveTimeWindow(range: WafRangeInput): { startTime: Date; endTime: Date } {
  if (isCustomRange(range)) {
    return { startTime: new Date(range.start), endTime: new Date(range.end) };
  }
  const endTime = new Date();
  return { startTime: new Date(endTime.getTime() - RANGE_MS[range]), endTime };
}

/**
 * Produce the range segment used in cache keys.
 * Preset ranges -> their string value; custom ranges -> `custom#<start>#<end>`.
 */
export function rangeToCacheSegment(range: WafRangeInput): string {
  if (isCustomRange(range)) return `custom#${range.start}#${range.end}`;
  return range;
}

/**
 * Time range to CloudWatch Logs Insights bin size mapping.
 * Determines the aggregation bucket for time-series queries.
 */
export const BIN_BY_RANGE: Record<WafTrafficRange, '5m' | '1h' | '6h'> = {
  '1h': '5m',
  '24h': '1h',
  '7d': '6h',
};

/**
 * Parse an ISO timestamp string into a validated ISO string.
 * Returns null if the timestamp is invalid.
 *
 * @param ts - ISO timestamp string (e.g., "2024-01-15T10:30:00Z")
 * @returns Validated ISO string or null if invalid
 */
export function parseIsoTimestamp(ts: string): string | null {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Parse log group information from an ARN.
 *
 * @param arn - CloudWatch Logs log group ARN
 * @returns Object with region and name, or null if parsing fails
 *
 * @example
 * parseLogGroupInfoFromArn('arn:aws:logs:us-east-1:123456789012:log-group:aws-waf-logs-mygroup')
 * // => { region: 'us-east-1', name: 'aws-waf-logs-mygroup' }
 */
export function parseLogGroupInfoFromArn(arn: string): { region: string; name: string } | null {
  // Example: arn:aws:logs:us-east-1:123456789012:log-group:aws-waf-logs-mygroup
  const match = /^arn:aws:logs:([^:]+):\d{12}:log-group:([^:]+)(?::.*)?$/.exec(arn);
  if (!match) return null;
  const region = match[1]?.trim();
  const name = match[2]?.trim();
  if (!region || !name) return null;
  return { region, name };
}

/**
 * Escape a string literal for use in CloudWatch Logs Insights queries.
 * Handles backslashes and double quotes.
 *
 * @param value - String to escape
 * @returns Escaped string safe for use in Insights query string literals
 *
 * @example
 * escapeInsightsStringLiteral('rule"with\\special')
 * // => 'rule\\"with\\\\special'
 */
export function escapeInsightsStringLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Validate a CloudFront distribution ID.
 *
 * CloudFront distribution IDs are 11-14 uppercase alphanumeric characters (e.g., "E16LJAOKPV5LK1").
 * This guard prevents unexpected values from being used as AWS API parameters.
 *
 * @param id - Value to validate
 * @returns true if the value matches the expected CloudFront distribution ID format
 */
export function isValidCloudFrontDistributionId(id: string): boolean {
  return /^[A-Z0-9]{11,14}$/.test(id);
}

/**
 * Validate a string for use as a field value in a CloudWatch Logs Insights filter expression.
 *
 * AWS WAF label names and terminating rule IDs consist of alphanumeric characters plus
 * hyphens, underscores, colons, and dots (e.g., "awswaf:managed:aws:core-rule-set:NoUserAgent_Header").
 * Rejecting unexpected characters provides defence-in-depth against query injection even after escaping.
 *
 * @param value - String to validate
 * @returns true if the value contains only characters safe for WAF label/group ID field values
 */
export function isValidWafLabelOrGroupId(value: string): boolean {
  return /^[A-Za-z0-9:._\-/]+$/.test(value);
}

/**
 * Parse the WebACL name from a WAFv2 ARN.
 *
 * @param webAclArn - WAFv2 WebACL ARN (e.g. "arn:aws:wafv2:us-east-1:123:global/webacl/bike4mind-api-protection-pr6391/<uuid>")
 * @returns The WebACL name segment, or null if the ARN is not in the expected format
 */
export function parseWebAclNameFromArn(webAclArn: string): string | null {
  const marker = '/webacl/';
  const idx = webAclArn.indexOf(marker);
  if (idx < 0) return null;
  const rest = webAclArn.slice(idx + marker.length);
  const [name] = rest.split('/');
  return name || null;
}

/**
 * Resolve the Router CloudFront distribution ID from SST Resource link.
 *
 * The Router resource is deployed by SST and linked to the frontend Lambda (see infra/web.ts),
 * so we can access its distribution ID directly without runtime CloudFront API discovery.
 *
 * This eliminates the need for cloudfront:ListDistributions and cloudfront:ListTagsForResource permissions,
 * avoids pagination bugs, and removes per-request latency.
 *
 * @throws {NotFoundError} if the distribution ID is missing or has an unexpected format
 */
export function resolveRouterDistributionId(): string {
  const routerResource = Resource as typeof Resource & {
    RouterDistributionId?: { id: string };
  };

  const distributionId = routerResource.RouterDistributionId?.id;
  if (typeof distributionId !== 'string' || distributionId.length === 0) {
    throw new NotFoundError('Router CloudFront distribution ID not available in SST Resource link.');
  }
  if (!isValidCloudFrontDistributionId(distributionId)) {
    throw new NotFoundError(`Router CloudFront distribution ID has unexpected format: ${distributionId}`);
  }

  return distributionId;
}
