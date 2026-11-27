/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { previewStageNumber, sharedRuleConditions, sharedRulePriorities } from '../previewSharedChatOrigin';

// infra/chatCompletion.ts only loads inside `sst`, so wiring is asserted against its source text.
const source = readFileSync(new URL('../chatCompletion.ts', import.meta.url), 'utf8');
const squashed = source.replace(/\s+/g, ' ');
const webSource = readFileSync(new URL('../web.ts', import.meta.url), 'utf8');
const contract = JSON.parse(readFileSync(new URL('../deploy-contract.json', import.meta.url), 'utf8')) as {
  deployEnv: string[];
};

describe('previewStageNumber', () => {
  it.each([
    ['pr8616', 8616],
    ['pr1', 1],
  ])('reads %s as %d', (stage, expected) => {
    expect(previewStageNumber(stage)).toBe(expected);
  });

  it.each(['production', 'dev', 'pr', 'pr12a', 'xpr12', 'jude'])('has no number for %s', stage => {
    expect(previewStageNumber(stage)).toBeUndefined();
  });
});

describe('sharedRulePriorities', () => {
  it('gives each preview two adjacent priorities', () => {
    expect(sharedRulePriorities(8616)).toEqual({ cloudfront: 17233, direct: 17234 });
  });

  it('stays inside the listener priority range', () => {
    for (const n of [0, 1, 24998, 24999, 25000, 49999, 123456]) {
      const { cloudfront, direct } = sharedRulePriorities(n);
      expect(cloudfront).toBeGreaterThanOrEqual(1);
      expect(direct).toBeLessThanOrEqual(50000);
    }
  });

  it('never overlaps between neighbouring previews', () => {
    const used = new Set<number>();
    for (let n = 1; n <= 24999; n++) {
      const { cloudfront, direct } = sharedRulePriorities(n);
      expect(used.has(cloudfront) || used.has(direct)).toBe(false);
      used.add(cloudfront).add(direct);
    }
  });
});

describe('sharedRuleConditions', () => {
  const host = 'chat-origin-pr1.preview.example.test';
  const directPaths = ['/process', '/health'] as const;

  it('matches the host and origin header for CloudFront, and the host, paths and NAT IPs for direct calls', () => {
    expect(
      sharedRuleConditions({
        host,
        originVerify: { header: 'x-b4m-origin-verify', value: 'secret' },
        directPaths,
        natCidrs: ['203.0.113.1/32'],
      })
    ).toEqual({
      cloudfront: [
        { hostHeader: { values: [host] } },
        { httpHeader: { httpHeaderName: 'x-b4m-origin-verify', values: ['secret'] } },
      ],
      direct: [
        { hostHeader: { values: [host] } },
        { pathPattern: { values: ['/process', '/health'] } },
        { sourceIp: { values: ['203.0.113.1/32'] } },
      ],
    });
  });

  it('forwards on the host alone with origin verification off', () => {
    expect(sharedRuleConditions({ host, directPaths, natCidrs: ['203.0.113.1/32'] })).toEqual({
      cloudfront: [{ hostHeader: { values: [host] } }],
    });
  });

  it('refuses more condition values than an ALB rule allows', () => {
    expect(() =>
      sharedRuleConditions({
        host,
        originVerify: { header: 'x-b4m-origin-verify', value: 'secret' },
        directPaths,
        natCidrs: ['203.0.113.1/32', '203.0.113.2/32', '203.0.113.3/32'],
      })
    ).toThrow(/condition values/);
  });
});

describe('ChatCompletion wiring for the shared preview load balancer', () => {
  it('reads the listener only on preview stages that use the shared certificate', () => {
    expect(squashed).toContain(
      'const sharedListenerArn = sharedOriginCertificateArn && originDomain && previewNumber !== undefined ? process.env.PREVIEW_CHAT_SHARED_LISTENER_ARN || undefined : undefined;'
    );
    expect(source).toMatch(
      /const sharedOriginCertificateArn =\s*isPreviewStage && !\$dev \? process\.env\.PREVIEW_CHAT_ORIGIN_CERT_ARN/
    );
  });

  it('creates no load balancer of its own in shared mode', () => {
    expect(squashed).toContain('loadBalancer: sharedListenerTarget ? undefined : { public: true,');
  });

  it('attaches the service to the shared target group once the rules exist', () => {
    expect(squashed).toContain('targetGroupArn: sharedListenerTarget.attachedTargetGroupArn,');
    expect(squashed).toContain('$util.all([targetGroup.arn, ...rules.map(rule => rule.arn)]).apply(([arn]) => arn)');
  });

  it('keeps its rules out of the transform that only targets SST-named rules', () => {
    for (const name of source.match(/new aws\.lb\.ListenerRule\('(\w+)'/g) ?? []) {
      expect(name).not.toContain("'ChatCompletionListener");
    }
  });

  it('reuses the alias record name so a switch updates it in place', () => {
    expect(source.match(/createAlias\(\s*'ChatCompletionOrigin'/g)).toHaveLength(1);
  });

  it('skips the per-stage task ingress rule in shared mode', () => {
    expect(squashed).toContain('if (!sharedListenerTarget) { const defaultSecurityGroupId');
  });

  it('hands the frontend the shared origin URL', () => {
    expect(webSource).toContain(
      '...(chatCompletionSharedOriginUrl ? { CHAT_COMPLETION_ORIGIN_URL: chatCompletionSharedOriginUrl } : {}),'
    );
  });

  it('declares the deploy-time variable in the contract', () => {
    expect(contract.deployEnv).toContain('PREVIEW_CHAT_SHARED_LISTENER_ARN');
  });
});
