import { describe, expect, it } from 'vitest';
import { bodyExcerpt, lakeRagUrl } from './http';

describe('lakeRagUrl', () => {
  it.each(['https://app.example.com', 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])(
    'accepts %s',
    base => {
      expect(lakeRagUrl(base, '/api/x').pathname).toBe('/api/x');
    }
  );

  it.each(['http://app.example.com', 'http://localhost.example.com'])('refuses plain http to %s', base => {
    expect(() => lakeRagUrl(base, '/api/x')).toThrow(/https/);
  });
});

describe('bodyExcerpt', () => {
  it('redacts token-shaped runs and flattens control characters', () => {
    const out = bodyExcerpt('bad key b4m_live_abc123 and eyJhbGciOi.eyJzdWIiOiJ1In0.c2ln\n\tline\u0007two');
    expect(out).toBe('bad key b4m_live_[redacted] and [jwt redacted] line two');
  });

  it('caps the excerpt', () => {
    const out = bodyExcerpt('x'.repeat(1000));
    expect(out).toBe(`${'x'.repeat(200)}...`);
  });
});
