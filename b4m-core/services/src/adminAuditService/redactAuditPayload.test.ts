import { describe, expect, it } from 'vitest';
import { redactAuditPayload, redactChange } from './redactAuditPayload';

describe('redactAuditPayload', () => {
  it('redacts secret-looking keys at any depth, including inside arrays', () => {
    const result = redactAuditPayload({
      name: 'ok',
      client: { clientSecret: 's', list: [{ apiKey: 'k', keep: 1 }, [{ passwordHash: 'h' }]] },
      accessToken: 't',
      credentials: { user: 'u' },
    });
    expect(result).toEqual({
      name: 'ok',
      client: {
        clientSecret: '[REDACTED]',
        list: [{ apiKey: '[REDACTED]', keep: 1 }, [{ passwordHash: '[REDACTED]' }]],
      },
      accessToken: '[REDACTED]',
      credentials: '[REDACTED]',
    });
  });

  it('does not mutate the input and preserves dates', () => {
    const date = new Date();
    const input = { token: 'x', when: date };
    const result = redactAuditPayload(input);
    expect(input.token).toBe('x');
    expect(result.when).toBe(date);
  });

  it('survives circular references', () => {
    const input: Record<string, unknown> = { a: 1 };
    input.self = input;
    expect(redactAuditPayload(input)).toEqual({ a: 1, self: '[CIRCULAR]' });
  });

  it('redacts token keys only as a whole key or suffix', () => {
    const result = redactAuditPayload({
      token: 'a',
      accessToken: 'b',
      refresh_token: 'c',
      'id-token': 'd',
      maxTokens: 4096,
      tokenEndpointAuthMethod: 'client_secret_basic',
    });
    expect(result).toEqual({
      token: '[REDACTED]',
      accessToken: '[REDACTED]',
      refresh_token: '[REDACTED]',
      'id-token': '[REDACTED]',
      maxTokens: 4096,
      tokenEndpointAuthMethod: 'client_secret_basic',
    });
  });

  it('redactChange hides both sides when the field is secret, else redacts nested values', () => {
    expect(redactChange({ field: 'apiKey', before: 'a', after: 'b' })).toEqual({
      field: 'apiKey',
      before: '[REDACTED]',
      after: '[REDACTED]',
    });
    expect(redactChange({ field: 'maxTokens', before: 1, after: 2 })).toEqual({
      field: 'maxTokens',
      before: 1,
      after: 2,
    });
    expect(redactChange({ field: 'config', before: { password: 'x' }, after: { ok: 1 } })).toEqual({
      field: 'config',
      before: { password: '[REDACTED]' },
      after: { ok: 1 },
    });
  });
});
