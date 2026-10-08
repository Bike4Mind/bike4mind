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
  it('redacts a token cut short by the scan cap or missing its signature', () => {
    expect(bodyExcerpt('token eyJhbGciOi.eyJzdWIi')).toBe('token [jwt redacted]');
    expect(bodyExcerpt(`${' '.repeat(8180)}eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig`)).toBe('[jwt redacted]');
  });

  it('bounds the work on a huge body of unterminated token prefixes', () => {
    const started = Date.now();
    bodyExcerpt('eyJ'.repeat(200_000) + '!');
    bodyExcerpt('eyJa.'.repeat(200_000));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('redacts token-shaped runs and flattens control characters', () => {
    const out = bodyExcerpt('bad key b4m_live_abc123 and eyJhbGciOi.eyJzdWIiOiJ1In0.c2ln\n\tline\u0007two');
    expect(out).toBe('bad key b4m_live_[redacted] and [jwt redacted] line two');
  });

  it('caps the excerpt', () => {
    const out = bodyExcerpt('x'.repeat(1000));
    expect(out).toBe(`${'x'.repeat(200)}...`);
  });
});
