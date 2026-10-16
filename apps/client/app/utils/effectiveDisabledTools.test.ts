import { describe, it, expect, vi } from 'vitest';
import { effectiveDisabledTools } from './effectiveDisabledTools';

vi.mock('@server/premium-generated/premiumWorkspaceDeniedTools.generated', () => ({
  premiumWorkspaceDeniedTools: { 'example-workspace': ['tool_a', 'tool_b'] },
}));

describe('effectiveDisabledTools', () => {
  it('is undefined without a session', () => {
    expect(effectiveDisabledTools(undefined)).toBeUndefined();
    expect(effectiveDisabledTools(null)).toBeUndefined();
  });

  it('passes the session denylist through for a main-list session', () => {
    expect(effectiveDisabledTools({ disabledTools: ['web_search'] })).toEqual(['web_search']);
    expect(effectiveDisabledTools({})).toBeUndefined();
  });

  it('unions the surface denials with the session denylist', () => {
    const result = effectiveDisabledTools({ surface: 'example-workspace', disabledTools: ['tool_b', 'web_search'] });

    expect(result?.sort()).toEqual(['tool_a', 'tool_b', 'web_search']);
  });

  it('ignores a surface the table does not name', () => {
    expect(effectiveDisabledTools({ surface: 'elsewhere', disabledTools: ['web_search'] })).toEqual(['web_search']);
  });
});
