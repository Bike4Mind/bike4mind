import { describe, it, expect } from 'vitest';
import { deprecationHeaders, deprecationNotice } from './deprecation';

describe('deprecationHeaders', () => {
  it('emits RFC 9745 Deprecation, RFC 8594 Sunset and a successor Link', () => {
    expect(
      deprecationHeaders({ since: '2026-10-15', sunset: '2027-01-15', successor: '/api/v1/music-generations' })
    ).toEqual({
      Deprecation: '@1792022400',
      Sunset: 'Fri, 15 Jan 2027 00:00:00 GMT',
      Link: '</api/v1/music-generations>; rel="successor-version"',
    });
  });

  it('omits Link when there is no successor', () => {
    expect(deprecationHeaders({ since: '2026-10-15', sunset: '2027-01-15' })).not.toHaveProperty('Link');
  });
});

describe('deprecationNotice', () => {
  it('names the sunset and the successor', () => {
    expect(deprecationNotice({ since: '2026-10-15', sunset: '2027-01-15', successor: '/api/v1/x' })).toBe(
      '**Deprecated, sunset 2027-01-15.** Use `/api/v1/x` instead.'
    );
  });
});
