// Pure helpers for the preview ChatCompletion load balancer that previews share
// (infra/chatCompletion.ts, infra/preview-shared-chat-origin-alb.md). No SST globals, so they are unit-tested
// directly.

export const PREVIEW_SHARED_STAGE_TAG = 'b4m:preview-stage';

const PRIORITY_SLOTS = 24999;

export function previewStageNumber(stage: string): number | undefined {
  const match = /^pr(\d+)$/.exec(stage);
  return match ? Number(match[1]) : undefined;
}

// Each preview owns two adjacent priorities on the shared listener, derived from its PR number so concurrent
// deploys never race for one. Hosts are unique per preview, so ordering between previews does not matter; only
// uniqueness does. Range 1..49999 (ALB allows 1..50000).
export function sharedRulePriorities(prNumber: number): { cloudfront: number; direct: number } {
  const base = 2 * (prNumber % PRIORITY_SLOTS) + 1;
  return { cloudfront: base, direct: base + 1 };
}

type HostCondition = { hostHeader: { values: string[] } };
type HeaderCondition = { httpHeader: { httpHeaderName: string; values: string[] } };
type PathCondition = { pathPattern: { values: string[] } };
type SourceIpCondition = { sourceIp: { values: string[] } };

const MAX_CONDITION_VALUES = 5;

// Same admission as a stage's own load balancer: CloudFront requests carrying the stage's origin header, plus the
// direct paths from the NAT egress IPs. With origin verification off, the host alone forwards.
export function sharedRuleConditions(args: {
  host: string;
  originVerify?: { header: string; value: string };
  directPaths: readonly string[];
  natCidrs: string[];
}): {
  cloudfront: Array<HostCondition | HeaderCondition>;
  direct?: Array<HostCondition | PathCondition | SourceIpCondition>;
} {
  const host: HostCondition = { hostHeader: { values: [args.host] } };
  if (!args.originVerify) return { cloudfront: [host] };
  const directValues = 1 + args.directPaths.length + args.natCidrs.length;
  if (directValues > MAX_CONDITION_VALUES) {
    throw new Error(
      `The shared preview direct-path rule needs ${directValues} condition values; an ALB rule allows ${MAX_CONDITION_VALUES}.`
    );
  }
  return {
    cloudfront: [host, { httpHeader: { httpHeaderName: args.originVerify.header, values: [args.originVerify.value] } }],
    direct: [host, { pathPattern: { values: [...args.directPaths] } }, { sourceIp: { values: args.natCidrs } }],
  };
}
