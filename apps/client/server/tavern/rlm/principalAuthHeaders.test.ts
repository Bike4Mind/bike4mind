import { describe, it, expect } from 'vitest';
import { resolvePrincipalAuthHeaders } from './principalAuthHeaders';

describe('resolvePrincipalAuthHeaders', () => {
  it('forwards a JWT/browser caller Authorization header', () => {
    expect(resolvePrincipalAuthHeaders({ authorization: 'Bearer jwt.abc.def' })).toEqual({
      authorization: 'Bearer jwt.abc.def',
    });
  });

  it('forwards an api-key caller x-api-key header', () => {
    expect(resolvePrincipalAuthHeaders({ 'x-api-key': 'b4m_live_caller' })).toEqual({
      'x-api-key': 'b4m_live_caller',
    });
  });

  it('forwards both when the caller sent both', () => {
    expect(
      resolvePrincipalAuthHeaders({ 'x-api-key': 'b4m_live_caller', authorization: 'ApiKey b4m_live_caller' })
    ).toEqual({ 'x-api-key': 'b4m_live_caller', authorization: 'ApiKey b4m_live_caller' });
  });

  it('fails closed rather than substituting a shared identity', () => {
    expect(resolvePrincipalAuthHeaders({})).toBeNull();
    expect(resolvePrincipalAuthHeaders({ 'x-api-key': '   ', authorization: '' })).toBeNull();
  });

  it('ignores non-credential headers', () => {
    expect(resolvePrincipalAuthHeaders({ cookie: 'session=1', 'user-agent': 'curl' })).toBeNull();
  });
});
