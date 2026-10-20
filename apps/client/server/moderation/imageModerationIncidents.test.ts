import { describe, expect, it } from 'vitest';
import { resolveAdminAppUrl } from './imageModerationIncidents';

describe('resolveAdminAppUrl', () => {
  it('prefers APP_URL', () => {
    expect(resolveAdminAppUrl({ APP_URL: 'https://router.example', SERVER_DOMAIN: 'example.com' })).toBe(
      'https://router.example'
    );
  });

  it('derives the app origin from SERVER_DOMAIN when APP_URL is unset', () => {
    expect(resolveAdminAppUrl({ SERVER_DOMAIN: 'example.com' })).toBe('https://app.example.com');
    expect(resolveAdminAppUrl({ APP_URL: ' ', SERVER_DOMAIN: 'https://example.com/' })).toBe('https://app.example.com');
  });

  it('returns undefined when neither is set, leaving a relative link', () => {
    expect(resolveAdminAppUrl({ SERVER_DOMAIN: '' })).toBeUndefined();
  });
});
