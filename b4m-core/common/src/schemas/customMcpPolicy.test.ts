import { describe, expect, it } from 'vitest';
import {
  combineCustomMcpPolicyVerdicts,
  evaluateCustomMcpPolicy,
  matchesMcpHostPattern,
  type CustomMcpPolicyDenyReason,
  type CustomMcpPolicyInput,
} from './customMcpPolicy';
import { CUSTOM_MCP_POLICY_MODES, CustomMcpPolicySchema, type CustomMcpPolicyMode } from './settings';
import type { McpConnectionAuthKind } from '../types/entities/McpConnectionTypes';

const policy = (overrides: Partial<CustomMcpPolicyInput['policy']> = {}): CustomMcpPolicyInput['policy'] => ({
  ...CustomMcpPolicySchema.parse({}),
  ...overrides,
});

const input = (overrides: Partial<CustomMcpPolicyInput> = {}): CustomMcpPolicyInput => ({
  urlHost: 'mcp.example.com',
  authKind: 'api_key',
  policy: policy({ mode: 'any' }),
  platformBlockedHosts: [],
  ...overrides,
});

function reasonOf(overrides: Partial<CustomMcpPolicyInput>): CustomMcpPolicyDenyReason | 'allowed' {
  const verdict = evaluateCustomMcpPolicy(input(overrides));
  return verdict.allowed ? 'allowed' : verdict.reason;
}

describe('matchesMcpHostPattern', () => {
  it.each([
    ['mcp.example.com', 'mcp.example.com', true],
    ['MCP.Example.com.', 'mcp.example.com', true],
    ['mcp.example.com', ' MCP.EXAMPLE.COM ', true],
    ['a.example.com', '*.example.com', true],
    ['a.b.example.com', '*.example.com', true],
    ['example.com', '*.example.com', false],
    ['badexample.com', '*.example.com', false],
    ['example.com.evil.net', '*.example.com', false],
    ['example.com', 'example.co', false],
    ['', 'example.com', false],
  ])('%j against %j is %s', (host, pattern, expected) => {
    expect(matchesMcpHostPattern(host, pattern)).toBe(expected);
  });
});

describe('evaluateCustomMcpPolicy', () => {
  const modes: CustomMcpPolicyMode[] = [...CUSTOM_MCP_POLICY_MODES];
  const authKinds: McpConnectionAuthKind[] = ['none', 'api_key', 'oauth'];

  // The full matrix for a custom URL (no preset), with allowUnauthenticated on and off, the host on
  // or off the org allowlist.
  const expectedFor = (
    mode: CustomMcpPolicyMode,
    authKind: McpConnectionAuthKind,
    allowUnauthenticated: boolean,
    allowlisted: boolean
  ): CustomMcpPolicyDenyReason | 'allowed' => {
    if (mode === 'off') return 'org_disabled';
    if (mode === 'presets_only') return 'presets_only';
    if (mode === 'allowlist' && !allowlisted) return 'host_not_allowlisted';
    if (authKind === 'none' && !allowUnauthenticated) return 'unauthenticated_not_allowed';
    return 'allowed';
  };

  for (const mode of modes) {
    for (const authKind of authKinds) {
      for (const allowUnauthenticated of [true, false]) {
        for (const allowlisted of [true, false]) {
          const expected = expectedFor(mode, authKind, allowUnauthenticated, allowlisted);
          it(`mode=${mode} auth=${authKind} allowUnauthenticated=${allowUnauthenticated} allowlisted=${allowlisted} -> ${expected}`, () => {
            expect(
              reasonOf({
                authKind,
                policy: policy({
                  mode,
                  allowUnauthenticated,
                  allowedHostPatterns: allowlisted ? ['*.example.com'] : ['other.example.org'],
                }),
              })
            ).toBe(expected);
          });
        }
      }
    }
  }

  it('the platform blocklist wins over every mode, including any and a matching allowlist', () => {
    for (const mode of modes) {
      expect(
        reasonOf({
          platformBlockedHosts: ['*.example.com'],
          policy: policy({ mode, allowedHostPatterns: ['mcp.example.com'] }),
        })
      ).toBe('platform_blocked_host');
    }
  });

  it('the org blocklist applies in every open mode and beats the allowlist', () => {
    for (const mode of ['any', 'allowlist', 'presets_only'] as const) {
      expect(
        reasonOf({
          presetRemoteHost: 'mcp.example.com',
          policy: policy({ mode, blockedHostPatterns: ['mcp.example.com'], allowedHostPatterns: ['mcp.example.com'] }),
        })
      ).toBe('org_blocked_host');
    }
  });

  it('presets_only admits a catalog preset only on its own host', () => {
    const presetsOnly = policy({ mode: 'presets_only' });
    expect(reasonOf({ presetRemoteHost: 'mcp.example.com', policy: presetsOnly })).toBe('allowed');
    expect(reasonOf({ presetRemoteHost: 'MCP.example.com.', policy: presetsOnly })).toBe('allowed');
    expect(reasonOf({ presetRemoteHost: 'mcp.other.com', policy: presetsOnly })).toBe('presets_only');
    expect(reasonOf({ presetRemoteHost: undefined, policy: presetsOnly })).toBe('presets_only');
  });

  it('a preset still needs sign-in when unauthenticated servers are refused', () => {
    expect(
      reasonOf({
        authKind: 'none',
        presetRemoteHost: 'mcp.example.com',
        policy: policy({ mode: 'presets_only', allowUnauthenticated: false }),
      })
    ).toBe('unauthenticated_not_allowed');
  });

  it('the default policy is fail-closed for a custom URL', () => {
    expect(reasonOf({ policy: CustomMcpPolicySchema.parse({}) })).toBe('presets_only');
  });

  it('a denial carries a readable message', () => {
    const verdict = evaluateCustomMcpPolicy(input({ policy: policy({ mode: 'off' }) }));
    expect(verdict).toMatchObject({ allowed: false, reason: 'org_disabled' });
    expect(verdict.allowed ? '' : verdict.message).toMatch(/turned off/);
  });
});

describe('combineCustomMcpPolicyVerdicts', () => {
  it('allows only when every verdict allows, and reports the first denial', () => {
    expect(combineCustomMcpPolicyVerdicts([])).toEqual({ allowed: true });
    expect(combineCustomMcpPolicyVerdicts([{ allowed: true }, { allowed: true }])).toEqual({ allowed: true });
    expect(
      combineCustomMcpPolicyVerdicts([
        { allowed: true },
        { allowed: false, reason: 'org_blocked_host', message: 'a' },
        { allowed: false, reason: 'org_disabled', message: 'b' },
      ])
    ).toMatchObject({ allowed: false, reason: 'org_blocked_host' });
  });
});
