import { describe, it, expect } from 'vitest';
import { resolveBootstrapAdmin } from './bootstrapAdmin';

const base = { isSelfHost: true, userCount: 0, email: 'owner@example.com', bootstrapEmail: undefined };

describe('resolveBootstrapAdmin', () => {
  it('is never eligible outside self-host', () => {
    expect(resolveBootstrapAdmin({ ...base, isSelfHost: false })).toEqual({ eligible: false, unconfigured: false });
  });

  it('is never eligible once a user exists', () => {
    expect(resolveBootstrapAdmin({ ...base, userCount: 1, bootstrapEmail: 'owner@example.com' }).eligible).toBe(false);
    expect(resolveBootstrapAdmin({ ...base, userCount: 1 }).eligible).toBe(false);
  });

  it('matches the configured email after trimming and lowercasing it', () => {
    expect(resolveBootstrapAdmin({ ...base, bootstrapEmail: ' Owner@Example.COM ' })).toEqual({
      eligible: true,
      unconfigured: false,
    });
  });

  it('rejects any other email when one is configured', () => {
    expect(
      resolveBootstrapAdmin({ ...base, email: 'someone@example.com', bootstrapEmail: 'owner@example.com' })
    ).toEqual({ eligible: false, unconfigured: false });
  });

  it.each([undefined, '', '   '])('falls back to the first account when the configured email is %j', bootstrapEmail => {
    expect(resolveBootstrapAdmin({ ...base, bootstrapEmail })).toEqual({ eligible: true, unconfigured: true });
  });
});
