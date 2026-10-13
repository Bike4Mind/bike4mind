import { describe, it, expect, vi } from 'vitest';

vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.patch = () => chain;
    chain.get = () => chain;
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({ User: {} }));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), error: vi.fn() } }));

import { EmailSettingsSchema } from '../email-settings';

describe('email-settings platformEmailAddress local part', () => {
  it('rejects reserved local parts case-insensitively', () => {
    for (const address of ['admin@example.com', 'Postmaster@example.com', 'NO-REPLY@example.com']) {
      expect(EmailSettingsSchema.safeParse({ platformEmailAddress: address }).success).toBe(false);
    }
  });

  it('accepts a non-reserved local part', () => {
    const result = EmailSettingsSchema.safeParse({ platformEmailAddress: 'Jane.Doe@example.com' });
    expect(result.success).toBe(true);
  });
});
