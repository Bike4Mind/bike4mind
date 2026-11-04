import { describe, expect, it } from 'vitest';
import { requestLogUrl } from './requestLogUrl';

describe('search request log URLs', () => {
  it.each(['b4m_live_' + 'a'.repeat(32), '192.0.2.1', 'person@example.com'])('redacts %s', identifier => {
    expect(requestLogUrl(`/api/admin/search?q=${encodeURIComponent(identifier)}`)).toBe('/api/admin/search');
  });
  it('preserves other request paths', () => {
    expect(requestLogUrl('/api/admin/users?limit=10')).toBe('/api/admin/users?limit=10');
  });
});
