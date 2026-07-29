/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { getDevWafMeta, buildDevWafRuleJson } from '../wafPolicy';

interface WafRule {
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
}

const mockEmergencyIpSetArn = 'arn:aws:wafv2:us-east-1:123456789012:global/ipset/test-ipset/abc123';

// any: deeply nested AWS WAF statement shapes - a bare ByteMatch or an OrStatement of them
/** The CommonRuleSet scope-down statement for a stage, exactly as WAF receives it. */
function commonRuleSetScopeDown(stage: string): any {
  const parsed = JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));
  const rule = parsed.find((r: WafRule) => r.Name === 'AWS-AWSManagedRulesCommonRuleSet');
  return (rule.Statement.ManagedRuleGroupStatement as any)?.ScopeDownStatement;
}

/** Search strings the statement matches against UriPath, at any nesting depth. */
function uriPathMatches(scopeDown: any): string[] {
  const found: string[] = [];
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    const byteMatch = node.ByteMatchStatement;
    if (byteMatch?.FieldToMatch?.UriPath && typeof byteMatch.SearchString === 'string') {
      found.push(byteMatch.SearchString);
    }
    Object.values(node).forEach(walk);
  };
  walk(scopeDown);
  return found;
}

describe('wafPolicy', () => {
  describe('getDevWafMeta', () => {
    it('returns WAF metadata with default name suffix for dev stage', () => {
      const result = getDevWafMeta({ stage: 'dev' });

      expect(result.name).toBe('bike4mind-api-protection-dev');
      expect(result.description).toContain('Bike4Mind');
      expect(result.scope).toBe('CLOUDFRONT');
      expect(result.defaultAction).toEqual({ allow: {} });
      expect(result.visibilityConfig).toEqual({
        sampledRequestsEnabled: true,
        cloudwatchMetricsEnabled: true,
        metricName: 'bike4mind-api-protection-dev',
      });
    });

    it('returns WAF metadata with custom name suffix', () => {
      const result = getDevWafMeta({ nameSuffix: 'pr6391', stage: 'dev' });

      expect(result.name).toBe('bike4mind-api-protection-pr6391');
      expect(result.visibilityConfig.metricName).toBe('bike4mind-api-protection-pr6391');
    });

    it('returns WAF metadata for production stage', () => {
      const result = getDevWafMeta({ stage: 'production' });

      expect(result.description).toContain('production');
    });
  });

  describe('buildDevWafRuleJson — dev stage', () => {
    it('pins Allow-LLM-API at Priority 0 so ai-route-rate-limit bypass is preserved', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'dev' });
      const parsed = JSON.parse(ruleJson);

      const allowLlmRule = parsed.find((rule: WafRule) => rule.Name === 'Allow-LLM-API');
      expect(allowLlmRule).toBeDefined();
      expect(allowLlmRule.Priority).toBe(0);
    });

    it('returns a valid JSON string with all required rules', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'dev' });
      const parsed = JSON.parse(ruleJson);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);

      const ruleNames = parsed.map((rule: WafRule) => rule.Name);
      expect(ruleNames).toContain('emergency-ip-block');
      expect(ruleNames).toContain('api-rate-limit');
    });

    it('replaces the emergency IPSet ARN placeholder', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'dev' });
      const parsed = JSON.parse(ruleJson);

      const ipBlockRule = parsed.find((rule: WafRule) => rule.Name === 'emergency-ip-block');
      expect(ipBlockRule).toBeDefined();
      expect(ipBlockRule.Statement.IPSetReferenceStatement.ARN).toBe(mockEmergencyIpSetArn);
    });

    it('uses the elevated 10,000 req/5min rate limit for Cypress CI', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'dev' });
      const parsed = JSON.parse(ruleJson);

      const rateLimitRule = parsed.find((rule: WafRule) => rule.Name === 'api-rate-limit');
      expect(rateLimitRule).toBeDefined();
      expect(rateLimitRule.Statement.RateBasedStatement.Limit).toBe(10000);
      expect(rateLimitRule.Statement.RateBasedStatement.AggregateKeyType).toBe('IP');
    });

    it('includes AWS managed rule groups', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'dev' });
      const parsed = JSON.parse(ruleJson);

      const managedRules = parsed.filter((rule: WafRule) => rule.Statement?.ManagedRuleGroupStatement);
      expect(managedRules.length).toBeGreaterThan(0);

      const ruleGroupNames = managedRules.map(
        (rule: WafRule) => (rule.Statement.ManagedRuleGroupStatement as Record<string, unknown>)?.Name as string
      );
      expect(ruleGroupNames).toContain('AWSManagedRulesCommonRuleSet');
      expect(ruleGroupNames).toContain('AWSManagedRulesKnownBadInputsRuleSet');
    });

    it('sets AdminProtection_URIPATH to Count so the SPA /admin route is not blocked (#9180)', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'dev' });
      const parsed = JSON.parse(ruleJson);

      const adminRule = parsed.find((rule: WafRule) => rule.Name === 'AWS-AWSManagedRulesAdminProtectionRuleSet');
      expect(adminRule).toBeDefined();

      // any: deeply nested AWS WAF managed-rule-group statement shape
      const mgs = adminRule.Statement.ManagedRuleGroupStatement as any;
      const override = (mgs.RuleActionOverrides ?? []).find(
        (o: { Name: string }) => o.Name === 'AdminProtection_URIPATH'
      );
      expect(override).toBeDefined();
      expect(override.ActionToUse).toEqual({ Count: {} });
    });

    it('has no duplicate priorities', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'dev' });
      const parsed = JSON.parse(ruleJson);

      const priorities = parsed.map((rule: WafRule) => rule.Priority);
      expect(new Set(priorities).size).toBe(priorities.length);
    });

    it('gives every rule a visibility config', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'dev' });
      const parsed = JSON.parse(ruleJson);

      for (const rule of parsed as WafRule[]) {
        expect(rule.VisibilityConfig).toBeDefined();
        expect(rule.VisibilityConfig.SampledRequestsEnabled).toBe(true);
        expect(rule.VisibilityConfig.CloudWatchMetricsEnabled).toBe(true);
        expect(rule.VisibilityConfig.MetricName).toBeTruthy();
      }
    });

    it('contains no undefined or null values', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'dev' });

      expect(ruleJson).not.toContain('undefined');
      expect(ruleJson).not.toContain(': null');
    });

    // The admin settings PUT carries prompt text containing '../' (from an instruction not to use
    // relative imports), which CommonRuleSet's GenericLFI_BODY reads as path traversal. The
    // endpoint is admin-gated and CASL-checked, and the other managed groups still apply to it.
    it('exempts /api/settings/update from CommonRuleSet so prompt text can be saved', () => {
      const scopeDown = commonRuleSetScopeDown('dev');

      // The NotStatement IS the exemption - without it the scope-down inverts and CommonRuleSet
      // would apply to these paths ONLY, leaving every other route unprotected.
      expect(scopeDown.NotStatement).toBeDefined();

      const exempt = uriPathMatches(scopeDown);
      expect(exempt).toContain('/api/settings/update');
      expect(exempt).toContain('/api/modals/');
    });
  });

  describe('buildDevWafRuleJson — production stage', () => {
    it('pins Allow-LLM-API at Priority 0 so completions endpoint is not counted by ai-route-rate-limit', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'production' });
      const parsed = JSON.parse(ruleJson);

      const allowLlmRule = parsed.find((rule: WafRule) => rule.Name === 'Allow-LLM-API');
      expect(allowLlmRule).toBeDefined();
      expect(allowLlmRule.Priority).toBe(0);
    });

    it('uses the tighter 2,000 req/5min rate limit for production', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'production' });
      const parsed = JSON.parse(ruleJson);

      const rateLimitRule = parsed.find((rule: WafRule) => rule.Name === 'api-rate-limit');
      expect(rateLimitRule).toBeDefined();
      expect(rateLimitRule.Statement.RateBasedStatement.Limit).toBe(2000);
    });

    it('includes the ai-route-rate-limit rule at Priority 4', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'production' });
      const parsed = JSON.parse(ruleJson);

      const aiRule = parsed.find((rule: WafRule) => rule.Name === 'ai-route-rate-limit');
      expect(aiRule).toBeDefined();
      expect(aiRule.Priority).toBe(4);
      expect(aiRule.Statement.RateBasedStatement.Limit).toBe(300);
    });

    it('has no duplicate priorities', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'production' });
      const parsed = JSON.parse(ruleJson);

      const priorities = parsed.map((rule: WafRule) => rule.Priority);
      expect(new Set(priorities).size).toBe(priorities.length);
    });

    it('replaces the emergency IPSet ARN placeholder', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'production' });
      const parsed = JSON.parse(ruleJson);

      const ipBlockRule = parsed.find((rule: WafRule) => rule.Name === 'emergency-ip-block');
      expect(ipBlockRule).toBeDefined();
      expect(ipBlockRule.Statement.IPSetReferenceStatement.ARN).toBe(mockEmergencyIpSetArn);
    });

    it('sets AdminProtection_URIPATH to Count so the SPA /admin route is not blocked (#9180)', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'production' });
      const parsed = JSON.parse(ruleJson);

      const adminRule = parsed.find((rule: WafRule) => rule.Name === 'AWS-AWSManagedRulesAdminProtectionRuleSet');
      expect(adminRule).toBeDefined();

      // any: deeply nested AWS WAF managed-rule-group statement shape
      const mgs = adminRule.Statement.ManagedRuleGroupStatement as any;
      const override = (mgs.RuleActionOverrides ?? []).find(
        (o: { Name: string }) => o.Name === 'AdminProtection_URIPATH'
      );
      expect(override).toBeDefined();
      expect(override.ActionToUse).toEqual({ Count: {} });
    });

    it('exempts /api/settings/update from CommonRuleSet without losing the /api/modals/ exemption', () => {
      const scopeDown = commonRuleSetScopeDown('production');

      // See the dev-stage counterpart: dropping the NotStatement inverts the scope-down.
      expect(scopeDown.NotStatement).toBeDefined();

      const exempt = uriPathMatches(scopeDown);
      expect(exempt).toContain('/api/settings/update');
      expect(exempt).toContain('/api/modals/');
    });
  });
});
