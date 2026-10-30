/**
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  getDevWafMeta,
  buildDevWafRuleJson as buildWafRuleJson,
  parseWafBlockedIps,
  resolveWafPolicyDir,
} from '../wafPolicy';

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
const mockRateExemptIpSetArn = 'deployment-rate-exempt-ipset';

const buildDevWafRuleJson = (args: { emergencyIpSetArn: string; stage: string }): string =>
  buildWafRuleJson({ ...args, rateExemptIpSetArn: mockRateExemptIpSetArn });

/**
 * True when WAF_POLICY_DIR points the suite at a deployment's own policy rather than the committed
 * sample. Structural invariants run either way; exact limits belong to each deployment.
 */
const externalPolicy = Boolean(process.env.WAF_POLICY_DIR);

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
    // A regex exemption has the same effect on traffic as a byte match and was invisible here, so
    // the same bypass spelled as a RegexMatchStatement passed every assertion in this file.
    const regexMatch = node.RegexMatchStatement;
    if (regexMatch?.FieldToMatch?.UriPath && typeof regexMatch.RegexString === 'string') {
      found.push({
        searchString: regexMatch.RegexString,
        positionalConstraint: 'REGEX',
        textTransformations: (regexMatch.TextTransformations ?? []).map((t: { Type: string }) => t.Type),
      });
    }
    // A pattern set keeps its patterns in a separate AWS resource, so nothing in this repo can
    // read them. Returning silently would read as a pass, which is the failure mode this whole
    // walker exists to prevent - so refuse to answer instead.
    if (node.RegexPatternSetReferenceStatement?.FieldToMatch?.UriPath) {
      throw new Error(
        'RegexPatternSetReferenceStatement: patterns live in a separate AWS resource and cannot be ' +
          'inspected from this repo, so path assertions here cannot cover it. Assert on the pattern ' +
          'set directly, or do not use one in a policy these tests are meant to guard.'
      );
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

/**
 * The six machine-posted scanner-ingest endpoints, each a static route file under
 * apps/client/pages/api/admin/security-dashboard/ with nothing routed below it.
 *
 * They post raw scanner output, which the signature groups read as an attack payload. Probed
 * live against staging: a benign report body reaches the app (403 application/json from the
 * ingest token check), a real ZAP "SQL Injection" alert body comes back as a CloudFront 403 from
 * SQLiRuleSet, and a `${jndi:` body comes back the same way from KnownBadInputsRuleSet. Managed
 * rule groups enforce as soon as the firewall is attached, while every production rate limit is
 * only counting, so a group missing from the exemption list breaks the weekly ingest at the
 * moment the firewall goes on rather than a week later.
 */
const INGEST_PATHS = [
  '/api/admin/security-dashboard/attack-simulation-ingest',
  '/api/admin/security-dashboard/cloud-prowler-ingest',
  '/api/admin/security-dashboard/code-semgrep-ingest',
  '/api/admin/security-dashboard/packages-ingest',
  '/api/admin/security-dashboard/secrets-ingest',
  '/api/admin/security-dashboard/web-owasp-ingest',
];

// EXACTLY, not STARTS_WITH: an exemption is a hole in a rule group, so a prefix match hands that
// hole to every future sibling route, and these paths have no siblings. LOWERCASE so casing
// cannot change which requests fall through it.
const ingestExemptions = (): UriPathMatch[] =>
  INGEST_PATHS.map(searchString => ({
    searchString,
    positionalConstraint: 'EXACTLY',
    textTransformations: ['LOWERCASE'],
  }));

const BOT_CONTROL_RULE = 'AWS-AWSManagedRulesBotControlRuleSet';

const hasBotControl = (
  JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'dev' })) as WafRule[]
).some(r => r.Name === BOT_CONTROL_RULE);

// Prefix, not EXACTLY: the whole static and image trees are skipped. Full transformation chain so
// an encoded or oddly cased path cannot dodge the skip, and cannot slip into it either.
const botControlExemptions = (): UriPathMatch[] =>
  ['/_next/static/', '/_next/image'].map(searchString => ({
    searchString,
    positionalConstraint: 'STARTS_WITH',
    textTransformations: ['URL_DECODE', 'NORMALIZE_PATH', 'LOWERCASE'],
  }));

/**
 * Which managed rule groups may narrow themselves, and the complete exemption list each one
 * carries. Pinned as whole sets, because an assertion that only looks for what should be present
 * cannot see what should not: the previous version of this check used toContain on the search
 * string alone, so both a widened match and an extra exempted path passed it.
 *
 * Any group absent from this table must carry no scope-down at all.
 */
const EXPECTED_SCOPE_DOWNS: Record<string, UriPathMatch[]> = {
  'AWS-AWSManagedRulesCommonRuleSet': [
    { searchString: '/api/modals/', positionalConstraint: 'STARTS_WITH', textTransformations: ['NONE'] },
    { searchString: '/api/settings/update', positionalConstraint: 'EXACTLY', textTransformations: ['LOWERCASE'] },
    ...ingestExemptions(),
  ],
  'AWS-AWSManagedRulesSQLiRuleSet': [
    { searchString: '/api/ai/llm', positionalConstraint: 'STARTS_WITH', textTransformations: ['NONE'] },
    { searchString: '/api/modals/', positionalConstraint: 'STARTS_WITH', textTransformations: ['NONE'] },
    ...ingestExemptions(),
  ],
  'AWS-AWSManagedRulesKnownBadInputsRuleSet': ingestExemptions(),
  // A deployment-supplied policy may not have adopted Bot Control yet; the sample always has it.
  ...(hasBotControl ? { [BOT_CONTROL_RULE]: botControlExemptions() } : {}),
};

/**
 * Groups that narrow themselves by inclusion (the group applies to these paths only) rather than
 * by exemption, so they cannot be expressed in EXPECTED_SCOPE_DOWNS.
 */
const INCLUSION_SCOPED_GROUPS = ['AWS-AWSManagedRulesAnonymousIpList', 'AWS-AWSManagedRulesACFPRuleSet'];

const RATE_BLOCK = {
  Block: { CustomResponse: { ResponseCode: 429, ResponseHeaders: [{ Name: 'retry-after', Value: '300' }] } },
};

/** Managed rule group rules for a stage, by rule name. */
function managedRules(stage: string): Map<string, WafRule> {
  const rules: WafRule[] = JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));
  // any: ManagedRuleGroupStatement is deeply nested and not usefully typed here
  return new Map(rules.filter(r => (r.Statement as any).ManagedRuleGroupStatement).map(r => [r.Name, r]));
}

/** Stable order for comparing two exemption lists as sets. */
const sortMatches = (matches: UriPathMatch[]): UriPathMatch[] =>
  [...matches].sort((a, b) =>
    `${a.searchString} ${a.positionalConstraint}`.localeCompare(`${b.searchString} ${b.positionalConstraint}`)
  );

/**
 * The exemption list of a scope-down, accepting only the literal shape
 * NotStatement -> OrStatement -> ByteMatchStatement on UriPath.
 *
 * Structural on purpose, rather than a recursive search for paths. Every shape it rejects is a
 * live bypass that a path walker reads as a pass:
 *   - no NotStatement: the scope-down inverts, and the group applies to the exempted paths ONLY
 *   - AndStatement in place of the Or: NOT(A AND B) is true for every request once two paths are
 *     listed, so the group silently stops applying to anything at all
 *   - a leaf on a non-UriPath FieldToMatch: invisible to a path walker, so the list reads as
 *     empty and an empty-equals-empty assertion passes for entirely the wrong reason
 *   - any other statement type: a nested managed group, label or IP match is not a path exemption
 */
// any: deeply nested AWS WAF statement shapes
function scopeDownExemptions(where: string, scopeDown: any): UriPathMatch[] {
  expect(
    Object.keys(scopeDown ?? {}),
    `${where} must negate its exemptions; an inclusion applies the group to those paths ONLY`
  ).toEqual(['NotStatement']);

  const negated = scopeDown.NotStatement.Statement;
  expect(
    Object.keys(negated ?? {}),
    `${where} must negate an OrStatement; NOT(A AND B) is true for every request and disables the group`
  ).toEqual(['OrStatement']);
  expect(Object.keys(negated.OrStatement), `${where} OrStatement shape`).toEqual(['Statements']);

  // any: see above
  const statements: any[] = negated.OrStatement.Statements;
  statements.forEach((statement, i) => {
    expect(Object.keys(statement), `${where} entry ${i} must be a plain ByteMatchStatement`).toEqual([
      'ByteMatchStatement',
    ]);
    expect(
      Object.keys(statement.ByteMatchStatement.FieldToMatch ?? {}),
      `${where} entry ${i} must match on UriPath, or these path assertions cannot see it`
    ).toEqual(['UriPath']);
  });

  return statements.map(s => ({
    searchString: s.ByteMatchStatement.SearchString,
    positionalConstraint: s.ByteMatchStatement.PositionalConstraint,
    textTransformations: (s.ByteMatchStatement.TextTransformations ?? []).map((t: { Type: string }) => t.Type),
  }));
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

    it('aggregates the dev api rate limit by IP', () => {
      const ruleJson = buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'dev' });
      const parsed = JSON.parse(ruleJson);

      const rateLimitRule = parsed.find((rule: WafRule) => rule.Name === 'api-rate-limit');
      expect(rateLimitRule).toBeDefined();
      expect(rateLimitRule.Statement.RateBasedStatement.AggregateKeyType).toBe('IP');
    });

    it.each(['dev'])('answers every blocking rate rule with 429 and retry-after on %s', stage => {
      const rules: WafRule[] = JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));
      // any: RateBasedStatement and Action shapes are deeply nested
      const blocking = rules.filter(r => (r.Statement as any).RateBasedStatement && 'Block' in (r.Action as any));
      expect(blocking.length).toBeGreaterThan(0);
      for (const rule of blocking) {
        const custom = (rule.Action as any).Block.CustomResponse;
        expect(custom?.ResponseCode, `${rule.Name} status`).toBe(429);
        expect(custom?.ResponseHeaders, `${rule.Name} headers`).toContainEqual({ Name: 'retry-after', Value: '300' });
      }
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
      expect(ruleGroupNames).toContain('AWSManagedRulesAnonymousIpList');
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

  // Replaces the CommonRuleSet-only ingest check that used to live under `terminating Allow
  // rules`. That one asserted the six paths were present on one of the five groups, with
  // toContain on the search string, which is how the SQLi and KnownBadInputs gaps survived
  // review: CommonRuleSet is the group whose exemption was written, and the other two signature
  // groups were never asked about.
  describe('managed rule group scope-downs', () => {
    for (const stage of ['dev']) {
      it(`exempts exactly the intended paths from exactly the intended ${stage} rule groups`, () => {
        const managed = managedRules(stage);
        expect(managed.size, `${stage} must have managed rule groups`).toBeGreaterThan(0);

        // Which groups are narrowed is itself the invariant. AdminProtection and
        // AmazonIpReputationList are unscoped, and a scope-down appearing on either would be an
        // unreviewed hole that a per-group assertion would never look for.
        const scopedDown = [...managed.values()]
          // any: see the helpers above
          .filter(rule => (rule.Statement as any).ManagedRuleGroupStatement.ScopeDownStatement)
          .map(rule => rule.Name)
          .sort();
        expect(scopedDown, `${stage}: only these groups may narrow themselves`).toEqual(
          [...Object.keys(EXPECTED_SCOPE_DOWNS), ...INCLUSION_SCOPED_GROUPS].sort()
        );

        for (const [ruleName, expected] of Object.entries(EXPECTED_SCOPE_DOWNS)) {
          const rule = managed.get(ruleName);
          expect(rule, `${stage}: ${ruleName} must exist`).toBeDefined();

          // any: see the helpers above
          const scopeDown = (rule!.Statement as any).ManagedRuleGroupStatement.ScopeDownStatement;
          const found = scopeDownExemptions(`${stage} ${ruleName} scope-down`, scopeDown);
          expect(sortMatches(found), `${stage}: ${ruleName} exemption list`).toEqual(sortMatches(expected));
        }
      });

      // Stated separately from the table above so the failure names the actual defect. The three
      // signature groups inspect the same request body for different families, so an ingest path
      // exempted from one and not the others is still blocked; the exemption is only meaningful
      // if every group that has one carries the identical six.
      it(`exempts the scanner ingest paths identically in every scoped ${stage} group`, () => {
        const managed = managedRules(stage);

        // Bot Control counts only and skips static paths; it is not a signature group.
        for (const ruleName of Object.keys(EXPECTED_SCOPE_DOWNS).filter(n => n !== BOT_CONTROL_RULE)) {
          // any: see the helpers above
          const scopeDown = (managed.get(ruleName)!.Statement as any).ManagedRuleGroupStatement.ScopeDownStatement;
          const ingest = scopeDownExemptions(`${stage} ${ruleName} scope-down`, scopeDown).filter(m =>
            INGEST_PATHS.includes(m.searchString)
          );

          expect(
            sortMatches(ingest),
            `${stage}: ${ruleName} must exempt all six scanner-ingest paths, spelled identically`
          ).toEqual(sortMatches(ingestExemptions()));
        }
      });
    }
  });

  // Every path match in a rate limit's scope-down, at any nesting depth. A limit may assert one
  // prefix directly, or negate a whole set of them with NotStatement wrapping an OrStatement, so
  // returning a list is what lets one assertion cover both shapes.
  // any: WAF statements nest differently per type and the tree is not usefully typed here.
  function rateLimitByteMatches(rule: WafRule): any[] {
    const found: any[] = [];
    const walk = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (node.ByteMatchStatement) found.push(node.ByteMatchStatement);
      Object.values(node).forEach(walk);
    };
    walk((rule.Statement as any).RateBasedStatement?.ScopeDownStatement);
    return found;
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
    for (const stage of ['dev']) {
      it(`decodes before normalizing in every ${stage} rate limit`, () => {
        const limits = scopedRateLimits(stage);
        expect(limits.length).toBeGreaterThan(0);

        for (const rule of limits) {
          const matches = rateLimitByteMatches(rule);
          expect(matches.length, `${rule.Name} scope-down must match on a path`).toBeGreaterThan(0);

          for (const byteMatch of matches.filter(m => m.FieldToMatch.UriPath)) {
            const ordered = [...(byteMatch.TextTransformations ?? [])]
              .sort((a: { Priority: number }, b: { Priority: number }) => a.Priority - b.Priority)
              .map((t: { Type: string }) => t.Type);

            expect(ordered, `${rule.Name} must decode, then normalize, then lowercase`).toEqual([
              'URL_DECODE',
              'NORMALIZE_PATH',
              'LOWERCASE',
            ]);
          }
        }
      });

      it(`anchors every ${stage} rate limit to a URI path prefix`, () => {
        for (const rule of scopedRateLimits(stage)) {
          const matches = rateLimitByteMatches(rule);
          expect(
            matches.some(m => m.FieldToMatch.UriPath),
            `${rule.Name} must match on UriPath`
          ).toBe(true);
          // A Method match narrows by verb and is exempt; every other match must be a UriPath one.
          for (const byteMatch of matches.filter(m => !m.FieldToMatch.Method)) {
            expect(byteMatch.FieldToMatch.UriPath, `${rule.Name} must match on UriPath`).toBeDefined();
            // EXACTLY is accepted alongside STARTS_WITH because it is strictly tighter: it is what
            // single files such as /version.json use, so the match cannot creep to /version.jsonx.
            // What this rejects is CONTAINS and ENDS_WITH, neither anchored at the path root.
            expect(['STARTS_WITH', 'EXACTLY'], `${rule.Name} must be anchored at the path root`).toContain(
              byteMatch.PositionalConstraint
            );
          }
        }
      });
    }

    // The break-glass control and the managed rule groups are not part of the measurement week.
    // If Count ever spreads to these, the stage has no enforcing rule left at all.
    it('keeps the emergency IP block enforcing throughout', () => {
      const rules: WafRule[] = JSON.parse(
        buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage: 'dev' })
      );

      const emergency = rules.find(r => r.Name === 'emergency-ip-block');
      expect(emergency).toBeDefined();
      expect(emergency!.Action).toEqual({ Block: {} });

      // Bot Control and ACFP are the groups that count wholesale; their own suites pin them.
      const countWholesale = [BOT_CONTROL_RULE, 'AWS-AWSManagedRulesACFPRuleSet'];
      const enforcing = rules.filter(
        r => (r.Statement as any).ManagedRuleGroupStatement && !countWholesale.includes(r.Name)
      );
      for (const rule of enforcing) {
        expect(rule.OverrideAction, `${rule.Name} must not be overridden to Count wholesale`).toEqual({
          None: {},
        });
      }
    });
  });

  // A terminating Allow evaluated before emergency-ip-block exempts its paths from the
  // break-glass control and from every managed rule group, not just from a rate limit. Production
  // used to carry two of them; /api/admin/ has been removed in favour of the pattern staging has
  // run since July, and the surviving one is deliberate and documented below.
  describe('terminating Allow rules', () => {
    it('leaves only the completions endpoint exempted ahead of the emergency IP block', () => {
      // The completions path is a long-lived SSE POST carrying user prompt text, which the SQLi
      // and XSS signatures false-positive on, so this exemption stays until there is evidence for
      // removing it - and staging cannot supply that, since it runs the same rule.
      for (const stage of ['dev']) {
        const rules: WafRule[] = JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));

        const emergency = rules.find(r => r.Name === 'emergency-ip-block');
        const allowsBefore = rules
          .filter(r => r.Action && 'Allow' in r.Action && r.Priority < emergency!.Priority)
          .map(r => r.Name);

        expect(allowsBefore, stage).toEqual(['Allow-LLM-API']);
      }
    });

    // /api/admin/ was exempted from everything by a terminating Allow at priority 1. Staging has
    // never had that rule and handles the same traffic surgically instead: the specific ingest
    // paths are excluded from CommonRuleSet and AdminProtection_URIPATH is set to Count. Measured
    // before porting it: 10,981 /api/admin/ requests over 14 days on staging, every one ALLOW via
    // Default_Action, none blocked by any rule.
    // Both stages: the dev policy is what staging and every preview stage actually run, and this
    it('subjects /api/admin/ to the managed rules rather than exempting it', () => {
      for (const stage of ['dev']) {
        const rules: WafRule[] = JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));

        expect(
          rules.find(r => r.Name === 'allow-admin-endpoints'),
          stage
        ).toBeUndefined();

        // Matched with includes rather than startsWith on purpose: a regex spelling carries an
        // anchor, so '^/api/admin/' does not start with '/api/admin' and the obvious check reads
        // as a pass. Any Allow rule mentioning the admin prefix at all is what needs flagging.
        const exemptedPaths = rules
          .filter(r => r.Action && 'Allow' in r.Action)
          .flatMap(r => uriPathMatches(r.Statement).map(m => m.searchString));
        const adminExemptions = exemptedPaths.filter(path => path.includes('/api/admin'));
        expect(adminExemptions, `${stage}: no Allow rule may reference the admin prefix`).toEqual([]);
      }
    });

    it('matches the completions endpoint exactly, not by prefix', () => {
      for (const stage of ['dev']) {
        const rules: WafRule[] = JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));
        const allow = rules.find(r => r.Name === 'Allow-LLM-API');
        const matches = uriPathMatches(allow!.Statement);

        expect(matches.map(m => m.searchString).sort()).toEqual(['/api/ai/v1/completions', '/api/ai/v1/completions/']);
        for (const m of matches) {
          expect(m.positionalConstraint, `${stage} completions allow must not be a prefix`).toBe('EXACTLY');
          // On an Allow, a transform inverts polarity: every form it folds in becomes exempt from
          // all five managed rule groups. Asserted because the data was fixed and the guard was
          // not, so reverting the transforms passed every test in this file.
          expect(m.textTransformations, `${stage} completions allow transformations`).toEqual(['NONE']);
        }
      }
    });
  });

  // /api/otc/ is the email sign-in path as well as signup, so a Block here locks VPN, Tor and
  // cloud-egress users out of logging in. Both rules stay on Count until the metric has been read;
  // switching either to Block is a deliberate, separate change.
  describe('anonymous IP list on the sign-in code routes', () => {
    const ruleName = 'AWS-AWSManagedRulesAnonymousIpList';
    const forStage = (stage: string): WafRule[] =>
      JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));

    for (const stage of ['dev']) {
      it(`runs the group at Priority 1 on ${stage}`, () => {
        const rule = forStage(stage).find(r => r.Name === ruleName);
        expect(rule).toBeDefined();
        expect(rule!.Priority).toBe(1);
        expect(rule!.OverrideAction).toEqual({ None: {} });
        expect(rule!.Action).toBeUndefined();
        // any: ManagedRuleGroupStatement is deeply nested and not usefully typed here
        const mgs = (rule!.Statement as any).ManagedRuleGroupStatement;
        expect(mgs.VendorName).toBe('AWS');
        expect(mgs.Name).toBe('AWSManagedRulesAnonymousIpList');
      });

      it(`keeps both ${stage} group rules on Count (shadow mode)`, () => {
        const rule = forStage(stage).find(r => r.Name === ruleName);
        // any: see above
        const mgs = (rule!.Statement as any).ManagedRuleGroupStatement;
        expect(mgs.RuleActionOverrides).toEqual([
          { Name: 'AnonymousIPList', ActionToUse: { Count: {} } },
          { Name: 'HostingProviderIPList', ActionToUse: { Count: {} } },
        ]);
      });

      it(`scopes the ${stage} group to /api/otc/ with decode, normalize, lowercase in order`, () => {
        const rule = forStage(stage).find(r => r.Name === ruleName);
        // any: see above
        const scopeDown = (rule!.Statement as any).ManagedRuleGroupStatement.ScopeDownStatement;
        expect(Object.keys(scopeDown)).toEqual(['ByteMatchStatement']);
        expect(Object.keys(scopeDown.ByteMatchStatement.FieldToMatch)).toEqual(['UriPath']);
        expect(scopeDown.ByteMatchStatement.SearchString).toBe('/api/otc/');
        expect(scopeDown.ByteMatchStatement.PositionalConstraint).toBe('STARTS_WITH');

        const ordered = [...scopeDown.ByteMatchStatement.TextTransformations]
          .sort((a: { Priority: number }, b: { Priority: number }) => a.Priority - b.Priority)
          .map((t: { Type: string }) => t.Type);
        expect(ordered).toEqual(['URL_DECODE', 'NORMALIZE_PATH', 'LOWERCASE']);
      });

      it(`orders the ${stage} group after Allow-LLM-API and before emergency-ip-block`, () => {
        const rules = forStage(stage);
        const group = rules.find(r => r.Name === ruleName)!;
        const allow = rules.find(r => r.Name === 'Allow-LLM-API')!;
        const emergency = rules.find(r => r.Name === 'emergency-ip-block')!;
        expect(allow.Priority).toBeLessThan(group.Priority);
        expect(group.Priority).toBeLessThan(emergency.Priority);
        expect(rules.map(r => r.Name).indexOf(ruleName)).toBe(rules.map(r => r.Name).indexOf('Allow-LLM-API') + 1);
      });
    }
  });

  describe('path-scoped rate rules', () => {
    const forStage = (stage: string): WafRule[] =>
      JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));

    const uriMatch = (path: string, positionalConstraint: string) => ({
      path,
      positionalConstraint,
    });

    const SCOPED: Record<string, { uris: ReturnType<typeof uriMatch>[]; postOnly?: boolean }> = {
      'otc-verify-rate-limit': { uris: [uriMatch('/api/otc/verify', 'STARTS_WITH')] },
      'api-key-create-rate-limit': {
        uris: [uriMatch('/api/user-api-keys', 'EXACTLY'), uriMatch('/api/user-api-keys/', 'EXACTLY')],
        postOnly: true,
      },
      'credits-rate-limit': { uris: [uriMatch('/api/v1/credits', 'STARTS_WITH')] },
    };

    for (const stage of ['dev']) {
      for (const [name, { uris, postOnly }] of Object.entries(SCOPED)) {
        describe(`${name} on ${stage}`, () => {
          const find = () => forStage(stage).find(r => r.Name === name);

          it('blocks per IP over a 300 second window', () => {
            const rule = find();
            expect(rule).toBeDefined();
            expect(rule!.Action).toEqual(RATE_BLOCK);
            // any: RateBasedStatement shape is deeply nested
            const rate = (rule!.Statement as any).RateBasedStatement;
            expect(rate.AggregateKeyType).toBe('IP');
            expect(rate.EvaluationWindowSec).toBe(300);
          });

          it('is scoped to its path', () => {
            const rule = find()!;
            const matches = rateLimitByteMatches(rule);
            const paths = matches.filter(m => m.FieldToMatch.UriPath);
            expect(paths.map(m => [m.SearchString, m.PositionalConstraint])).toEqual(
              uris.map(uri => [uri.path, uri.positionalConstraint])
            );

            if (postOnly) {
              // any: RateBasedStatement shape is deeply nested
              const and = (rule.Statement as any).RateBasedStatement.ScopeDownStatement.AndStatement;
              expect(and.Statements).toHaveLength(2);
              // Both collection spellings share one bucket; child routes must remain outside it.
              expect(and.Statements[1]).toEqual({
                OrStatement: { Statements: paths.map(ByteMatchStatement => ({ ByteMatchStatement })) },
              });
              const methods = matches.filter(m => m.FieldToMatch.Method);
              expect(methods).toHaveLength(1);
              expect(methods[0].SearchString).toBe('POST');
              expect(methods[0].PositionalConstraint).toBe('EXACTLY');
            } else {
              expect(matches.filter(m => !m.FieldToMatch.UriPath)).toHaveLength(0);
            }
          });
        });
      }
    }

    it('gives every dev path-scoped rule a Count twin in the prod-shadow style', () => {
      const dev = forStage('dev');
      for (const name of Object.keys(SCOPED)) {
        const shadow = dev.find(r => r.Name === `${name}${SHADOW_SUFFIX}`);
        expect(shadow, `${name} shadow`).toBeDefined();
        expect(shadow!.Action).toEqual({ Count: {} });
        const enforcing = dev.find(rule => rule.Name === name)!;
        // A terminating Block at the same threshold would hide overflow from the Count twin.
        expect(shadow!.Priority, `${name} shadow must observe requests before blocking`).toBeLessThan(
          enforcing.Priority
        );
      }
    });
  });

  // Exact limits belong to each deployment, so these only pin the committed sample.
  describe.skipIf(externalPolicy)('sample policy rate limits', () => {
    // Pinned, not bounded: a greater-than assertion would pass a 10x loosening while failing a
    // tightening.
    const expected: Record<string, Record<string, number>> = {
      dev: {
        'api-rate-limit': 5000,
        'static-asset-rate-limit': 20000,
        'register-rate-limit': 500,
        'otc-verify-rate-limit': 30,
        'api-key-create-rate-limit': 20,
        'credits-rate-limit': 100,
        'otc-verify-rate-limit-prod-shadow': 30,
        'api-key-create-rate-limit-prod-shadow': 20,
        'credits-rate-limit-prod-shadow': 100,
        'api-rate-limit-prod-shadow': 1000,
        'ai-route-rate-limit-prod-shadow': 100,
        'register-rate-limit-prod-shadow': 30,
        'image-rate-limit-prod-shadow': 500,
        'default-rate-limit-prod-shadow': 2000,
        'static-asset-rate-limit-prod-shadow': 20000,
        'otc-send-rate-limit': 20,
        'credits-read-rate-limit': 50,
        'otc-send-asn-rate-limit': 100,
      },
    };

    for (const [stage, limits] of Object.entries(expected)) {
      it(`pins every ${stage} rate limit in the sample`, () => {
        const rules: WafRule[] = JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));
        const actual = Object.fromEntries(
          rules
            // any: RateBasedStatement shape is deeply nested
            .filter(r => (r.Statement as any).RateBasedStatement)
            .map(r => [r.Name, (r.Statement as any).RateBasedStatement.Limit])
        );
        expect(actual).toEqual(limits);
      });
    }
  });

  // A deployment-supplied policy adopts the group when it is ready; the sample always carries it.
  describe.skipIf(externalPolicy && !hasBotControl)('bot control in count', () => {
    type Transformation = { Priority: number; Type: string };
    type ByteMatch = { ByteMatchStatement: { TextTransformations: Transformation[] } };
    type BotControlRule = Omit<WafRule, 'Statement'> & {
      Statement: {
        ManagedRuleGroupStatement: {
          VendorName: string;
          Name: string;
          ManagedRuleGroupConfigs: unknown[];
          RuleActionOverrides?: unknown[];
          ScopeDownStatement: {
            NotStatement: { Statement: { OrStatement: { Statements: ByteMatch[] } } };
          };
        };
      };
    };
    const forStage = (stage: string): WafRule[] =>
      JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));

    const botControlForStage = (stage: string): BotControlRule | undefined =>
      forStage(stage).find(rule => rule.Name === BOT_CONTROL_RULE) as BotControlRule | undefined;

    for (const stage of ['dev']) {
      it(`runs the group at Priority 30 on ${stage}`, () => {
        const rule = botControlForStage(stage);
        expect(rule).toBeDefined();
        expect(rule!.Priority).toBe(30);
        expect(rule!.Action).toBeUndefined();
        const mgs = rule!.Statement.ManagedRuleGroupStatement;
        expect(mgs.VendorName).toBe('AWS');
        expect(mgs.Name).toBe('AWSManagedRulesBotControlRuleSet');
      });

      it(`uses the common inspection level on ${stage}, never targeted`, () => {
        const rule = botControlForStage(stage);
        const configs = rule!.Statement.ManagedRuleGroupStatement.ManagedRuleGroupConfigs;
        expect(configs).toEqual([{ AWSManagedRulesBotControlRuleSet: { InspectionLevel: 'COMMON' } }]);
        expect(JSON.stringify(rule)).not.toContain('TARGETED');
      });

      it(`counts the whole ${stage} group rather than blocking`, () => {
        const rule = botControlForStage(stage);
        expect(rule!.OverrideAction).toEqual({ Count: {} });
        expect(rule!.Statement.ManagedRuleGroupStatement.RuleActionOverrides).toBeUndefined();
      });

      it(`skips exactly the static and image prefixes on ${stage}, decode then normalize then lowercase`, () => {
        const rule = botControlForStage(stage);
        const scopeDown = rule!.Statement.ManagedRuleGroupStatement.ScopeDownStatement;
        const found = scopeDownExemptions(`${stage} ${BOT_CONTROL_RULE} scope-down`, scopeDown);
        expect(found).toEqual(botControlExemptions());

        const orderOf = (statement: ByteMatch) =>
          [...statement.ByteMatchStatement.TextTransformations]
            .sort((left, right) => left.Priority - right.Priority)
            .map(transformation => transformation.Type);
        for (const s of scopeDown.NotStatement.Statement.OrStatement.Statements) {
          expect(orderOf(s)).toEqual(['URL_DECODE', 'NORMALIZE_PATH', 'LOWERCASE']);
        }
      });

      it(`is the last ${stage} managed rule group, by priority`, () => {
        const rules = forStage(stage);
        // any: ManagedRuleGroupStatement shape is deeply nested
        const managed = rules.filter(r => (r.Statement as any).ManagedRuleGroupStatement);
        const maxManagedPriority = Math.max(...managed.map(r => r.Priority));
        expect(managed.find(r => r.Priority === maxManagedPriority)!.Name).toBe(BOT_CONTROL_RULE);

        // Only label-forwarding Count rules with LabelMatchStatement are allowed after Bot Control.
        const afterBotControl = rules.filter(r => r.Priority > maxManagedPriority);
        for (const rule of afterBotControl) {
          // any: LabelMatchStatement shape is deeply nested
          expect((rule.Statement as any).LabelMatchStatement).toBeDefined();
          expect(rule.Action).toMatchObject({ Count: expect.anything() });
        }
      });
    }
  });

  describe('ip reputation in count mode', () => {
    const IP_REP_RULE = 'AWS-AWSManagedRulesAmazonIpReputationList';
    const IP_REP_RULE_NAMES = ['AWSManagedIPReputationList', 'AWSManagedReconnaissanceList'];

    for (const stage of ['dev']) {
      it(`puts both ${stage} ip reputation rules in Count via RuleActionOverrides`, () => {
        const rules: WafRule[] = JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));
        const rule = rules.find(r => r.Name === IP_REP_RULE);
        expect(rule).toBeDefined();
        // any: ManagedRuleGroupStatement shape is deeply nested
        const mgs = (rule!.Statement as any).ManagedRuleGroupStatement;
        const overrides: { Name: string; ActionToUse: unknown }[] = mgs.RuleActionOverrides;
        expect(overrides).toBeDefined();
        const overrideNames = overrides.map(o => o.Name).sort();
        expect(overrideNames).toEqual([...IP_REP_RULE_NAMES].sort());
        for (const override of overrides) {
          expect(override.ActionToUse).toEqual({ Count: {} });
        }
        // OverrideAction stays None so the enforcing test excludes it from its check.
        expect(rule!.OverrideAction).toEqual({ None: {} });
      });
    }
  });

  describe('acfp account creation fraud prevention', () => {
    const ACFP_RULE = 'AWS-AWSManagedRulesACFPRuleSet';

    for (const stage of ['dev']) {
      it(`is present on ${stage} at a priority between Bot Control and the rate limits`, () => {
        const rules: WafRule[] = JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));
        const rule = rules.find(r => r.Name === ACFP_RULE);
        expect(rule).toBeDefined();
        expect(rule!.Priority).toBeGreaterThan(26);
        expect(rule!.Priority).toBeLessThan(30);
      });

      it(`counts the ${stage} ACFP group wholesale, with no per-rule overrides to drift from AWS`, () => {
        const rules: WafRule[] = JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));
        const rule = rules.find(r => r.Name === ACFP_RULE)!;
        // any: ManagedRuleGroupStatement shape is deeply nested
        expect((rule.Statement as any).ManagedRuleGroupStatement.RuleActionOverrides).toBeUndefined();
        expect(rule.OverrideAction).toEqual({ Count: {} });
      });

      it(`scopes the ${stage} ACFP group to /api/otc/ with decode+normalize+lowercase`, () => {
        const rules: WafRule[] = JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));
        const rule = rules.find(r => r.Name === ACFP_RULE)!;
        // any: ManagedRuleGroupStatement shape is deeply nested
        const mgs = (rule.Statement as any).ManagedRuleGroupStatement;
        const scopeDown = mgs.ScopeDownStatement?.ByteMatchStatement;
        expect(scopeDown).toBeDefined();
        expect(scopeDown.SearchString).toBe('/api/otc/');
        expect(scopeDown.PositionalConstraint).toBe('STARTS_WITH');
        const types = [...scopeDown.TextTransformations]
          .sort((a: { Priority: number }, b: { Priority: number }) => a.Priority - b.Priority)
          .map((t: { Type: string }) => t.Type);
        expect(types).toEqual(['URL_DECODE', 'NORMALIZE_PATH', 'LOWERCASE']);
      });

      it(`configures ${stage} ACFP ManagedRuleGroupConfigs with the OTC verify path`, () => {
        const rules: WafRule[] = JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));
        const rule = rules.find(r => r.Name === ACFP_RULE)!;
        // any: ManagedRuleGroupStatement shape is deeply nested
        const mgs = (rule.Statement as any).ManagedRuleGroupStatement;
        const configs: { AWSManagedRulesACFPRuleSet?: { CreationPath: string; RegistrationPagePath: string } }[] =
          mgs.ManagedRuleGroupConfigs;
        expect(configs).toBeDefined();
        const acfpConfig = configs.find(c => c.AWSManagedRulesACFPRuleSet)?.AWSManagedRulesACFPRuleSet;
        expect(acfpConfig).toBeDefined();
        expect(acfpConfig!.CreationPath).toBe('/api/otc/verify');
        expect(acfpConfig!.RegistrationPagePath).toBe('/api/otc/verify');
      });
    }
  });

  describe('forgery-guard rule', () => {
    for (const stage of ['dev']) {
      it(`blocks requests that carry a forged x-amzn-waf-x-waf-* header on ${stage}`, () => {
        const rules: WafRule[] = JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));
        const rule = rules.find(r => r.Name === 'block-forged-waf-forwarding-headers');
        expect(rule).toBeDefined();
        expect(rule!.Priority).toBe(28);
        // AWS WAF inserts these headers only after inspection, so a match here is always viewer-sent.
        expect(rule!.Action).toEqual({ Block: {} });
        const stmts = (rule!.Statement as any).OrStatement.Statements;
        const headers = stmts.map((s: any) => s.ByteMatchStatement.FieldToMatch.SingleHeader.Name);
        expect(headers).toContain('x-amzn-waf-x-waf-anon-ip');
        expect(headers).toContain('x-amzn-waf-x-waf-bot-signal');
      });
    }
  });

  describe('label-forwarding rules', () => {
    for (const stage of ['dev']) {
      it(`injects x-waf-anon-ip on ${stage} when the anonymous-ip label matches`, () => {
        const rules: WafRule[] = JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));
        const rule = rules.find(r => r.Name === 'forward-anon-ip-label');
        expect(rule).toBeDefined();
        expect(rule!.Priority).toBe(31);
        // any: LabelMatchStatement shape is deeply nested
        const label = (rule!.Statement as any).LabelMatchStatement;
        expect(label.Scope).toBe('LABEL');
        expect(label.Key).toBe('awswaf:managed:aws:anonymous-ip-list:AnonymousIPList');
        const headers = (rule!.Action as any)?.Count?.CustomRequestHandling?.InsertHeaders ?? [];
        expect(headers).toContainEqual({ Name: 'x-waf-anon-ip', Value: '1' });
      });

      it(`injects x-waf-bot-signal on ${stage} when any bot-control bot label matches`, () => {
        const rules: WafRule[] = JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));
        const rule = rules.find(r => r.Name === 'forward-bot-signal-label');
        expect(rule).toBeDefined();
        expect(rule!.Priority).toBe(32);
        // any: LabelMatchStatement shape is deeply nested
        const label = (rule!.Statement as any).LabelMatchStatement;
        expect(label.Scope).toBe('NAMESPACE');
        expect(label.Key).toBe('awswaf:managed:aws:bot-control:bot:');
        const headers = (rule!.Action as any)?.Count?.CustomRequestHandling?.InsertHeaders ?? [];
        expect(headers).toContainEqual({ Name: 'x-waf-bot-signal', Value: '1' });
      });
    }
  });

  describe('sign-in code and credits count-mode rate rules', () => {
    const forStage = (stage: string): WafRule[] =>
      JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));

    // Flip Action to Block in the policy to enforce; the block alarms follow the action.
    const EXPECTED: Record<string, { limit: number; window: number; key: unknown; paths: string[]; method?: string }> =
      {
        'otc-send-rate-limit': { limit: 20, window: 600, key: 'IP', paths: ['/api/otc/send'] },
        'credits-read-rate-limit': { limit: 50, window: 300, key: 'IP', paths: ['/api/v1/credits'], method: 'GET' },
        'otc-send-asn-rate-limit': { limit: 100, window: 600, key: 'CUSTOM_KEYS', paths: ['/api/otc/send'] },
      };

    for (const stage of ['dev', 'production']) {
      describe(stage, () => {
        for (const [name, want] of Object.entries(EXPECTED)) {
          it(`${name} counts ${want.limit} per ${want.window}s on its own route`, () => {
            const rule = forStage(stage).find(r => r.Name === name);
            expect(rule).toBeDefined();
            expect(rule!.Action).toEqual({ Count: {} });
            const rate = rule!.Statement.RateBasedStatement as {
              Limit: number;
              EvaluationWindowSec: number;
              AggregateKeyType: string;
              CustomKeys?: unknown[];
            };
            if (!externalPolicy) expect(rate.Limit).toBe(want.limit);
            expect(rate.EvaluationWindowSec).toBe(want.window);
            expect(rate.AggregateKeyType).toBe(want.key);
            if (want.key === 'CUSTOM_KEYS') expect(rate.CustomKeys).toEqual([{ ASN: {} }]);
            const matches = rateLimitByteMatches(rule!);
            expect(matches.filter(m => m.FieldToMatch.UriPath).map(m => m.SearchString)).toEqual(want.paths);
            const methods = matches.filter(m => m.FieldToMatch.Method);
            expect(methods.map(m => m.SearchString)).toEqual(want.method ? [want.method] : []);
          });

          it(`${name} skips the rate-exempt IP set and nothing else`, () => {
            const rule = forStage(stage).find(r => r.Name === name)!;
            const rate = rule.Statement.RateBasedStatement as {
              ScopeDownStatement: { AndStatement: { Statements: unknown[] } };
            };
            const and = rate.ScopeDownStatement.AndStatement;
            expect(and.Statements.at(-1)).toEqual({
              NotStatement: { Statement: { IPSetReferenceStatement: { ARN: mockRateExemptIpSetArn } } },
            });
            expect(JSON.stringify(rule)).not.toContain('PLACEHOLDER_');
          });
        }

        it('keeps the emergency IP set on its own rule, not the exempt one', () => {
          const rules = forStage(stage);
          const emergency = rules.find(r => r.Name === 'emergency-ip-block');
          expect(emergency!.Statement.IPSetReferenceStatement).toEqual({ ARN: mockEmergencyIpSetArn });
        });

        it('places the count rules ahead of every enforcing rate rule with unique priorities', () => {
          const rules = forStage(stage);
          const enforcingRateRules = rules.filter(
            rule => 'RateBasedStatement' in rule.Statement && rule.Action !== undefined && 'Block' in rule.Action
          );
          expect(enforcingRateRules.length).toBeGreaterThan(0);
          for (const name of Object.keys(EXPECTED)) {
            const countRule = rules.find(rule => rule.Name === name)!;
            for (const enforcingRule of enforcingRateRules) {
              expect(countRule.Priority, `${name} before ${enforcingRule.Name}`).toBeLessThan(enforcingRule.Priority);
            }
          }
          expect(new Set(rules.map(r => r.Priority)).size).toBe(rules.length);
        });
      });
    }
  });

  describe('resolveWafPolicyDir', () => {
    it('defaults to the committed sample under the working directory', () => {
      expect(resolveWafPolicyDir({})).toBe(path.join(process.cwd(), 'infra', 'waf'));
      expect(resolveWafPolicyDir({ WAF_POLICY_DIR: '  ' })).toBe(path.join(process.cwd(), 'infra', 'waf'));
    });

    it('uses an absolute WAF_POLICY_DIR as given', () => {
      expect(resolveWafPolicyDir({ WAF_POLICY_DIR: '/opt/waf-policy' })).toBe('/opt/waf-policy');
    });

    it('resolves a relative WAF_POLICY_DIR against the working directory', () => {
      expect(resolveWafPolicyDir({ WAF_POLICY_DIR: 'deploy/waf' })).toBe(path.join(process.cwd(), 'deploy', 'waf'));
    });

    it('loads the policy from WAF_POLICY_DIR when it is set', () => {
      const sourceDir = resolveWafPolicyDir(process.env);
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waf-policy-'));
      const original = process.env.WAF_POLICY_DIR;
      try {
        for (const file of ['bike4mind-api-protection-dev.json']) {
          const policy = JSON.parse(fs.readFileSync(path.join(sourceDir, file), 'utf8'));
          const apiRule = policy.Rules.find((r: WafRule) => r.Name === 'api-rate-limit');
          apiRule.Name = 'api-rate-limit-relocated';
          apiRule.Statement.RateBasedStatement.Limit = 1234;
          fs.writeFileSync(path.join(tempDir, file), JSON.stringify(policy));
        }

        process.env.WAF_POLICY_DIR = tempDir;
        for (const stage of ['dev']) {
          const rules: WafRule[] = JSON.parse(buildDevWafRuleJson({ emergencyIpSetArn: mockEmergencyIpSetArn, stage }));
          const relocated = rules.find(r => r.Name === 'api-rate-limit-relocated');
          expect(relocated, stage).toBeDefined();
          // any: RateBasedStatement shape is deeply nested
          expect((relocated!.Statement as any).RateBasedStatement.Limit).toBe(1234);
          expect(
            rules.find(r => r.Name === 'api-rate-limit'),
            stage
          ).toBeUndefined();
        }
      } finally {
        if (original === undefined) delete process.env.WAF_POLICY_DIR;
        else process.env.WAF_POLICY_DIR = original;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('parseWafBlockedIps', () => {
    const placeholder = ['192.0.2.0/32'];

    it('returns the placeholder when nothing is configured', () => {
      expect(parseWafBlockedIps(undefined)).toEqual(placeholder);
      expect(parseWafBlockedIps('')).toEqual(placeholder);
      expect(parseWafBlockedIps(' , ,')).toEqual(placeholder);
    });

    it('appends /32 to a bare address', () => {
      expect(parseWafBlockedIps('1.2.3.4')).toEqual(['1.2.3.4/32']);
    });

    it('trims, drops empties and keeps CIDR entries', () => {
      expect(parseWafBlockedIps(' 1.2.3.4 , 10.0.0.0/8 ,,')).toEqual(['1.2.3.4/32', '10.0.0.0/8']);
    });

    it('collapses duplicates, including a bare address and its /32, preserving order', () => {
      expect(parseWafBlockedIps('5.6.7.8,1.2.3.4,5.6.7.8,1.2.3.4/32')).toEqual(['5.6.7.8/32', '1.2.3.4/32']);
    });

    it('names the offending variable in the error', () => {
      expect(() => parseWafBlockedIps('nope', 'WAF_RATE_EXEMPT_IPS')).toThrow(/WAF_RATE_EXEMPT_IPS entry "nope"/);
    });

    it('rejects anything that is not an IPv4 address or CIDR', () => {
      expect(() => parseWafBlockedIps('not-an-ip')).toThrow(/not-an-ip/);
      expect(() => parseWafBlockedIps('1.2.3.4/40')).toThrow(/1\.2\.3\.4\/40/);
      expect(() => parseWafBlockedIps('0.0.0.0/0')).toThrow(/0\.0\.0\.0\/0/);
      expect(() => parseWafBlockedIps('1.2.3.4/08')).toThrow(/1\.2\.3\.4\/08/);
      expect(() => parseWafBlockedIps('::1')).toThrow(/::1/);
      expect(() => parseWafBlockedIps('1.2.3.4,999.1.1.1')).toThrow(/999\.1\.1\.1/);
    });
  });
});
