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

/** Suffix marking a rule as a Count-only clone of the production rule of the same base name. */
const SHADOW_SUFFIX = '-prod-shadow';

// any: deeply nested AWS WAF statement shapes - a bare ByteMatch or an OrStatement of them
/** The CommonRuleSet scope-down statement for a stage, exactly as WAF receives it. */
function commonRuleSetScopeDown(stage: string): any {
  const parsed = JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));
  const rule = parsed.find((r: WafRule) => r.Name === 'AWS-AWSManagedRulesCommonRuleSet');
  return (rule.Statement.ManagedRuleGroupStatement as any)?.ScopeDownStatement;
}

interface UriPathMatch {
  searchString: string;
  positionalConstraint: string;
  textTransformations: string[];
}

/**
 * Every UriPath match in the statement, at any nesting depth. Returns the match constraint and
 * transformations too, not just the path - a path exemption that silently widens from EXACTLY to
 * STARTS_WITH would otherwise pass unnoticed.
 */
function uriPathMatches(scopeDown: any): UriPathMatch[] {
  const found: UriPathMatch[] = [];
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    const byteMatch = node.ByteMatchStatement;
    if (byteMatch?.FieldToMatch?.UriPath && typeof byteMatch.SearchString === 'string') {
      found.push({
        searchString: byteMatch.SearchString,
        positionalConstraint: byteMatch.PositionalConstraint,
        textTransformations: (byteMatch.TextTransformations ?? []).map((t: { Type: string }) => t.Type),
      });
    }
    Object.values(node).forEach(walk);
  };
  walk(scopeDown);
  return found;
}

/** The settings-update exemption entry, or undefined if it is missing entirely. */
function settingsUpdateExemption(stage: string): UriPathMatch | undefined {
  return uriPathMatches(commonRuleSetScopeDown(stage)).find(m => m.searchString === '/api/settings/update');
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

    // The *-prod-shadow rules exist only to measure how often production's tighter thresholds
    // would be crossed by staging traffic. Count is what keeps them measurement-only: flip one to
    // Block and staging starts enforcing a limit nobody has validated, which would take the e2e
    // gate (and therefore prod promotion) down with it. Pin the action so that cannot happen quietly.
    it('keeps every prod-shadow rule on Count so staging enforcement is unchanged', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'dev' });
      const parsed = JSON.parse(ruleJson);

      const shadows = (parsed as WafRule[]).filter(rule => rule.Name.endsWith(SHADOW_SUFFIX));
      expect(shadows.length).toBeGreaterThan(0);

      for (const rule of shadows) {
        expect(rule.Action).toEqual({ Count: {} });
        expect(rule.OverrideAction).toBeUndefined();
      }
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

      const paths = uriPathMatches(scopeDown).map(m => m.searchString);
      expect(paths).toContain('/api/settings/update');
      expect(paths).toContain('/api/modals/');
    });

    // EXACTLY, not STARTS_WITH: a prefix match would hand the exemption to any future sibling route
    // such as /api/settings/update-bulk. LOWERCASE so casing cannot change which requests match.
    it('scopes the /api/settings/update exemption to an exact, lowercased path match', () => {
      expect(settingsUpdateExemption('dev')).toEqual({
        searchString: '/api/settings/update',
        positionalConstraint: 'EXACTLY',
        textTransformations: ['LOWERCASE'],
      });
    });
  });

  // Deliberately its own block: this invariant spans both stages, so it belongs in neither
  // the dev-stage nor the production-stage describe.
  describe('shadow parity between the dev and production policies', () => {
    // A shadow rule is only worth reading if it still mirrors the production rule it stands in for.
    // Nothing but a naming convention links the two, and they live in separate files, so a later
    // retune of production's limits would leave the shadow counting against a threshold nobody
    // enforces. That failure is invisible in the worst way: the metric still populates and the
    // number still looks meaningful, so it would be used to make the promotion call. Compare the
    // statements directly rather than trusting the copy.
    it('keeps every prod-shadow statement identical to the production rule it shadows', () => {
      const devRules: WafRule[] = JSON.parse(
        buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'dev' })
      );
      const prodRules: WafRule[] = JSON.parse(
        buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'production' })
      );

      const shadows = devRules.filter(rule => rule.Name.endsWith(SHADOW_SUFFIX));
      expect(shadows.length).toBeGreaterThan(0);

      for (const shadow of shadows) {
        const originName = shadow.Name.slice(0, -SHADOW_SUFFIX.length);
        const origin = prodRules.find(rule => rule.Name === originName);

        // A shadow whose origin has been renamed or removed is the same drift, caught earlier.
        expect(origin, `no production rule named ${originName} for ${shadow.Name}`).toBeDefined();
        expect(shadow.Statement).toEqual(origin!.Statement);
      }
    });
  });

  // The scope-down of a rate limit, whether asserted directly or negated with NotStatement.
  // any: WAF statements nest differently per type; this reaches the ByteMatch in either shape.
  function rateLimitByteMatch(rule: WafRule): any {
    const scopeDown = (rule.Statement as any).RateBasedStatement?.ScopeDownStatement;
    return scopeDown?.ByteMatchStatement ?? scopeDown?.NotStatement?.Statement?.ByteMatchStatement;
  }

  /** Every rate-based rule in a stage that narrows itself with a scope-down. */
  function scopedRateLimits(stage: string): WafRule[] {
    const rules: WafRule[] = JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));
    // any: see above
    return rules.filter(r => (r.Statement as any).RateBasedStatement?.ScopeDownStatement);
  }

  // A rate limit that matches the raw path is evadable, and the ORDER of the transformations is
  // the whole fix rather than their presence. They chain, each applied to the previous result, so
  // NORMALIZE_PATH before URL_DECODE leaves nothing to normalize the decoded form: verified
  // against staging with curl --path-as-is, /%2e/api/otc/send reaches the API with a 404
  // application/json yet reduces to /./api/otc/send, which starts with neither /api/ nor
  // /api/otc/send and is therefore counted by nothing. Decode, then normalize, then lowercase.
  // Double encoding (/%252e/...) is served the SPA shell and never reaches an endpoint, so it is
  // out of reach either way. Limits only: for an Allow or an exemption, a path that fails to
  // match is the safe direction, which is why the exemptions keep NONE.
  describe('rate limit path matching', () => {
    for (const stage of ['dev', 'production']) {
      it(`decodes before normalizing in every ${stage} rate limit`, () => {
        const limits = scopedRateLimits(stage);
        expect(limits.length).toBeGreaterThan(0);

        for (const rule of limits) {
          const byteMatch = rateLimitByteMatch(rule);
          expect(byteMatch, `${rule.Name} scope-down must match on a path`).toBeDefined();

          const ordered = [...(byteMatch.TextTransformations ?? [])]
            .sort((a: { Priority: number }, b: { Priority: number }) => a.Priority - b.Priority)
            .map((t: { Type: string }) => t.Type);

          expect(ordered, `${rule.Name} must decode, then normalize, then lowercase`).toEqual([
            'URL_DECODE',
            'NORMALIZE_PATH',
            'LOWERCASE',
          ]);
        }
      });

      it(`anchors every ${stage} rate limit to a URI path prefix`, () => {
        for (const rule of scopedRateLimits(stage)) {
          const byteMatch = rateLimitByteMatch(rule);

          expect(byteMatch.FieldToMatch.UriPath, `${rule.Name} must match on UriPath`).toBeDefined();
          expect(byteMatch.PositionalConstraint, `${rule.Name} must be prefix-anchored`).toBe('STARTS_WITH');
        }
      });
    }

    // /_next/image is a live server-side fetch and resize, not a static file: it answers with
    // application/json from a function. The blanket rule used to cover it and the scoped rule
    // does not, so without this it is the one expensive path with no ceiling at all.
    it('bounds the production image optimizer, below the static-asset ceiling', () => {
      const rules: WafRule[] = JSON.parse(
        buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'production' })
      );

      const image = rules.find(r => r.Name === 'image-rate-limit');
      expect(image).toBeDefined();

      // any: see above
      const rateBased = (image!.Statement as any).RateBasedStatement;
      const staticRule = rules.find(r => r.Name === 'static-asset-rate-limit');
      const staticLimit = (staticRule!.Statement as any).RateBasedStatement.Limit;

      expect(rateBased.ScopeDownStatement.ByteMatchStatement.SearchString).toBe('/_next/image');
      expect(rateBased.Limit).toBeLessThan(staticLimit);
    });

    // Scoping api-rate-limit to /api/ left everything that is neither /api/ nor an asset with no
    // ceiling, where the blanket rule had covered it. Next's rewrites run inside the server, so
    // the WAF only sees the pre-rewrite URI: /p/* and /uc/* are unauthenticated Lambda
    // invocations with an S3 fetch and no app-level limiter of their own.
    it('keeps a default ceiling on everything that is not an asset', () => {
      const rules: WafRule[] = JSON.parse(
        buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'production' })
      );

      const fallback = rules.find(r => r.Name === 'default-rate-limit');
      expect(fallback, 'production needs a catch-all rate limit').toBeDefined();

      // any: see above
      const rateBased = (fallback!.Statement as any).RateBasedStatement;
      const apiLimit = (rules.find(r => r.Name === 'api-rate-limit')!.Statement as any).RateBasedStatement.Limit;

      // Excludes only real assets. /_next/static/ is the sole prefix CloudFront routes to the
      // bucket, so /_next/data, /_next/image and any case variant stay function-backed and must
      // fall through to this ceiling rather than into the 50000 asset bucket.
      expect(rateBased.ScopeDownStatement.NotStatement.Statement.ByteMatchStatement.SearchString).toBe(
        '/_next/static/'
      );
      // Pinned, not bounded: this number is about to be retuned off a shadow reading, and a
      // greater-than assertion would pass a 10x loosening while failing a tightening.
      expect(rateBased.Limit).toBe(5000);
      expect(rateBased.Limit).toBeGreaterThan(apiLimit);
    });

    // Nothing else pins this. #1893's parity guard deep-equals Statement only, so flipping a
    // production limit to Count is invisible to every other test in this file. When these do go
    // to Count for a first week of measurement, this assertion is what makes coming back to
    // Block something the build demands rather than something someone remembers.
    it('enforces, rather than counts, every production rate limit', () => {
      const rules: WafRule[] = JSON.parse(
        buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'production' })
      );

      // any: see above
      const limits = rules.filter(r => (r.Statement as any).RateBasedStatement);
      expect(limits.length).toBeGreaterThan(0);

      for (const rule of limits) {
        expect(rule.Action, `${rule.Name} must Block, not Count`).toEqual({ Block: {} });
      }
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

    // 2000 per IP per 5 min is a sane ceiling for API calls and a wrong one for a page load:
    // roughly 56% of comparable traffic is /_next/static/ assets, and measured on staging the
    // unscoped form would have counted 331,374 of 517,542 requests in a day, with single IPs
    // reaching 18k in a 5-minute window. The limit was never the defect; applying it to every
    // request was. Assert the scope-down so the blanket form cannot come back unnoticed.
    it('scopes the production rate limit to /api/ so static assets do not consume the budget', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'production' });
      const parsed = JSON.parse(ruleJson);

      const rateLimitRule = parsed.find((rule: WafRule) => rule.Name === 'api-rate-limit');
      const rateBased = (rateLimitRule.Statement as any).RateBasedStatement;

      expect(rateBased.ScopeDownStatement).toBeDefined();
      expect(rateBased.ScopeDownStatement.ByteMatchStatement.SearchString).toBe('/api/');
      expect(rateBased.ScopeDownStatement.ByteMatchStatement.PositionalConstraint).toBe('STARTS_WITH');
      expect(rateBased.ScopeDownStatement.ByteMatchStatement.FieldToMatch.UriPath).toBeDefined();
    });

    // The asset backstop that makes the scope-down above safe: assets stop counting against the
    // API budget, but are still bounded so they cannot become a free amplification target.
    it('keeps a separate, higher ceiling for static assets', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'production' });
      const parsed = JSON.parse(ruleJson);

      const assetRule = parsed.find((rule: WafRule) => rule.Name === 'static-asset-rate-limit');
      expect(assetRule).toBeDefined();

      const rateBased = (assetRule.Statement as any).RateBasedStatement;
      expect(rateBased.Limit).toBe(50000);
      // Only /_next/static/ is routed to the assets bucket: probed staging, /_next/static/x answers
      // from AmazonS3 while /_next/x and /_NEXT/static/x both come from the default origin. So the
      // carve-out stops here and everything else under /_next/ stays function-backed.
      expect(rateBased.ScopeDownStatement.ByteMatchStatement.SearchString).toBe('/_next/static/');
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

      const paths = uriPathMatches(scopeDown).map(m => m.searchString);
      expect(paths).toContain('/api/settings/update');
      expect(paths).toContain('/api/modals/');
    });

    it('scopes the /api/settings/update exemption to an exact, lowercased path match', () => {
      expect(settingsUpdateExemption('production')).toEqual({
        searchString: '/api/settings/update',
        positionalConstraint: 'EXACTLY',
        textTransformations: ['LOWERCASE'],
      });
    });
  });
});
