import { describe, it, expect } from 'vitest';
import { resolveMailTransportKind } from './transport';

describe('resolveMailTransportKind', () => {
  it.each([
    ['nothing set', {}, 'smtp'],
    ['flag smtp', { MAIL_TRANSPORT: 'smtp' }, 'smtp'],
    ['flag ses on a hosted stage', { MAIL_TRANSPORT: 'ses' }, 'ses'],
    ['flag ses with odd casing and spacing', { MAIL_TRANSPORT: ' SES ' }, 'ses'],
    ['flag ses on self-host', { MAIL_TRANSPORT: 'ses', B4M_SELF_HOST: 'true' }, 'smtp'],
    ['self-host with no flag', { B4M_SELF_HOST: 'true' }, 'smtp'],
    ['unknown flag value', { MAIL_TRANSPORT: 'sendgrid' }, 'smtp'],
    ['empty flag', { MAIL_TRANSPORT: '' }, 'smtp'],
  ] as const)('%s -> %s', (_label, env, expected) => {
    expect(resolveMailTransportKind(env)).toBe(expected);
  });

  it('ignores whether SMTP settings are present, so the flag alone drives the cutover and the rollback', () => {
    expect(
      resolveMailTransportKind({ MAIL_TRANSPORT: 'ses', MAIL_HOST: 'smtp.example.com' } as Record<string, string>)
    ).toBe('ses');
    expect(resolveMailTransportKind({ MAIL_HOST: undefined } as Record<string, string | undefined>)).toBe('smtp');
  });
});
