/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { getAllowedOrigins } from '../allowedOrigins';

describe('getAllowedOrigins', () => {
  it('omits localhost on production', () => {
    const origins = getAllowedOrigins('example.com', 'production');
    expect(origins).toEqual(['https://app.example.com', 'https://staging.example.com']);
    expect(origins.some(o => o.includes('localhost'))).toBe(false);
  });

  it.each(['dev', 'pr123', 'someone'])('keeps localhost on %s', stage => {
    expect(getAllowedOrigins('example.com', stage)).toEqual([
      'http://localhost:3000',
      'https://localhost:3000',
      'https://app.example.com',
      'https://staging.example.com',
    ]);
  });

  it('returns no origins on production without a domain', () => {
    expect(getAllowedOrigins(undefined, 'production')).toEqual([]);
  });
});
