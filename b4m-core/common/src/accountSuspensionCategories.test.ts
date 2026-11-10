import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUSPENSION_REASON_CATEGORY,
  SUSPENSION_REASON_CATEGORIES,
  SUSPENSION_REASONS,
  buildSuspensionNotice,
  toSuspensionReasonCategory,
} from './accountSuspensionCategories';

describe('toSuspensionReasonCategory', () => {
  it.each(SUSPENSION_REASON_CATEGORIES)('keeps the known category %s', category => {
    expect(toSuspensionReasonCategory(category)).toBe(category);
  });

  it.each([undefined, null, '', 'deviceLinkedToBlocked', 42])('falls back to the generic category for %s', value => {
    expect(toSuspensionReasonCategory(value)).toBe(DEFAULT_SUSPENSION_REASON_CATEGORY);
  });
});

describe('buildSuspensionNotice', () => {
  it('names the category and the policy it breaks', () => {
    const notice = buildSuspensionNotice('multiple_accounts');
    expect(notice).toMatchObject({ category: 'multiple_accounts', policy: { slug: 'terms-of-service' } });
    expect(notice.message).toBe(
      'This account is suspended for using multiple accounts to obtain free credits, which our Terms of Service does not allow. If you believe this is a mistake, you can appeal by contacting support.'
    );
  });

  it('prefers the support email over the appeal URL', () => {
    expect(
      buildSuspensionNotice('automated_misuse', { email: 'support@example.com', url: 'https://example.com/support' })
        .message
    ).toContain('appeal by emailing support@example.com.');
    expect(buildSuspensionNotice('automated_misuse', { url: 'https://example.com/support' }).message).toContain(
      'appeal at https://example.com/support.'
    );
  });

  it('gives every category user copy that is ASCII and mentions no detector', () => {
    for (const category of SUSPENSION_REASON_CATEGORIES) {
      const { message } = buildSuspensionNotice(category);

      expect(message).toMatch(/^[\x20-\x7e]+$/);
      expect(message.toLowerCase()).not.toMatch(/signal|detect|fingerprint|device|ip address/);
      expect(SUSPENSION_REASONS[category].adminLabel).toBeTruthy();
    }
  });
});
