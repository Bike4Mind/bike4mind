/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { buildDevWafRuleJson } from '../wafPolicy';

type ScopeStatement =
  | { AndStatement: { Statements: ScopeStatement[] } }
  | { OrStatement: { Statements: ScopeStatement[] } }
  | {
      ByteMatchStatement: {
        SearchString: string;
        FieldToMatch: { Method: Record<string, never> } | { UriPath: Record<string, never> };
        PositionalConstraint: 'EXACTLY' | 'STARTS_WITH';
      };
    };

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a WAF statement object');
  }
  return value as Record<string, unknown>;
}

function parseScope(value: unknown): ScopeStatement {
  const statement = objectValue(value);
  if (Object.keys(statement).length !== 1) throw new Error('Expected exactly one WAF statement kind');
  for (const kind of ['AndStatement', 'OrStatement'] as const) {
    if (!(kind in statement)) continue;
    const children: unknown = objectValue(statement[kind]).Statements;
    if (!Array.isArray(children) || children.length === 0) throw new Error('Expected nonempty statements');
    const statements = children.map((child: unknown) => parseScope(child));
    return kind === 'AndStatement'
      ? { AndStatement: { Statements: statements } }
      : { OrStatement: { Statements: statements } };
  }
  const match = objectValue(statement.ByteMatchStatement);
  const field = objectValue(match.FieldToMatch);
  if (Object.keys(field).length !== 1 || (!('Method' in field) && !('UriPath' in field))) {
    throw new Error('Unsupported WAF match field');
  }
  const constraint = match.PositionalConstraint;
  if (typeof match.SearchString !== 'string' || (constraint !== 'EXACTLY' && constraint !== 'STARTS_WITH')) {
    throw new Error('Unsupported WAF byte match');
  }
  return {
    ByteMatchStatement: {
      SearchString: match.SearchString,
      FieldToMatch: 'Method' in field ? { Method: {} } : { UriPath: {} },
      PositionalConstraint: constraint,
    },
  };
}

function readRules(stage: string): Record<string, unknown>[] {
  const value: unknown = JSON.parse(
    buildDevWafRuleJson({
      emergencyIpSetArn: 'deployment-ipset',
      rateExemptIpSetArn: 'deployment-rate-exempt-ipset',
      stage,
    })
  );
  if (!Array.isArray(value)) throw new Error('Expected WAF rules');
  return value.map((rule: unknown) => objectValue(rule));
}

// This evaluates only the supported method/path boolean structure. Inputs are already
// normalized; wafPolicy.test.ts independently pins AWS's text transformation sequence.
function matchesScope(statement: ScopeStatement, method: string, pathname: string): boolean {
  if ('AndStatement' in statement) {
    return statement.AndStatement.Statements.every(child => matchesScope(child, method, pathname));
  }
  if ('OrStatement' in statement) {
    return statement.OrStatement.Statements.some(child => matchesScope(child, method, pathname));
  }
  const match = statement.ByteMatchStatement;
  const value = 'Method' in match.FieldToMatch ? method : pathname;
  return match.PositionalConstraint === 'EXACTLY' ? value === match.SearchString : value.startsWith(match.SearchString);
}

const cases = [
  { method: 'POST', path: '/api/user-api-keys', matches: true },
  { method: 'POST', path: '/api/user-api-keys/', matches: true },
  { method: 'POST', path: '/api/user-api-keys?source=profile', matches: true },
  { method: 'GET', path: '/api/user-api-keys', matches: false },
  { method: 'PATCH', path: '/api/user-api-keys', matches: false },
  { method: 'DELETE', path: '/api/user-api-keys', matches: false },
  { method: 'POST', path: '/api/user-api-keys/key-123', matches: false },
  { method: 'POST', path: '/api/user-api-keys/key-123/revoke', matches: false },
  { method: 'POST', path: '/api/user-api-keys/key-123/rotate', matches: false },
  { method: 'POST', path: '/api/user-api-keys/key-123/callback-secret', matches: false },
  { method: 'POST', path: '/api/user-api-keys-extra', matches: false },
] as const;

for (const stage of ['dev']) {
  const rules = readRules(stage);
  const names = ['api-key-create-rate-limit', 'api-key-create-rate-limit-prod-shadow'];

  for (const name of names) {
    describe(`${stage} ${name} scope`, () => {
      const rule = rules.find(candidate => candidate.Name === name);
      if (!rule) throw new Error(`Missing ${stage} rule: ${name}`);
      const rate = objectValue(objectValue(rule.Statement).RateBasedStatement);
      const scope = parseScope(rate.ScopeDownStatement);

      it.each(cases)('$method $path matches=$matches', ({ method, path, matches }) => {
        const pathname = new URL(path, 'https://example.com').pathname;
        expect(matchesScope(scope, method, pathname)).toBe(matches);
      });
    });
  }
}
