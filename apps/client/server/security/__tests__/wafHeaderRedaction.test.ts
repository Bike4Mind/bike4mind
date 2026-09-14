/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { WAF_MASKED_HEADER_VALUE, isWafDiagnosticHeader, maskWafRequestHeaders } from '../wafHeaderRedaction';

const valueOf = (headers: Array<{ name: string; value: string }>, name: string) =>
  headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;

describe('maskWafRequestHeaders', () => {
  it('serves diagnostic header values unchanged', () => {
    const masked = maskWafRequestHeaders([
      { name: 'host', value: 'app.example.com' },
      { name: 'user-agent', value: 'curl/8.4.0' },
      { name: 'x-forwarded-for', value: '203.0.113.7' },
    ]);

    expect(valueOf(masked, 'host')).toBe('app.example.com');
    expect(valueOf(masked, 'user-agent')).toBe('curl/8.4.0');
    expect(valueOf(masked, 'x-forwarded-for')).toBe('203.0.113.7');
  });

  it('masks the value of every credential header the app authenticates with', () => {
    const credentialHeaders = [
      'authorization',
      'proxy-authorization',
      'cookie',
      'x-api-key',
      'x-security-ingest-token',
      'x-e2e-cleanup-secret',
      'x-internal-ws-secret',
      'x-rate-limit-ingest-token',
      'x-webhook-token',
      'stripe-signature',
      'x-hub-signature',
      'x-hub-signature-256',
      'x-slack-signature',
    ];

    const masked = maskWafRequestHeaders(credentialHeaders.map(name => ({ name, value: 'the-secret-value' })));

    expect(masked.map(h => h.value)).toEqual(credentialHeaders.map(() => WAF_MASKED_HEADER_VALUE));
    expect(JSON.stringify(masked)).not.toContain('the-secret-value');
  });

  it('masks an unrecognized header rather than passing it through', () => {
    const masked = maskWafRequestHeaders([{ name: 'x-some-header-added-next-quarter', value: 'sk-live-abc' }]);

    expect(masked).toEqual([{ name: 'x-some-header-added-next-quarter', value: WAF_MASKED_HEADER_VALUE }]);
  });

  it('matches the allowlist case-insensitively, because WAF logs the casing the client sent', () => {
    const masked = maskWafRequestHeaders([
      { name: 'Host', value: 'app.example.com' },
      { name: 'X-Api-Key', value: 'the-secret-value' },
    ]);

    expect(valueOf(masked, 'Host')).toBe('app.example.com');
    expect(valueOf(masked, 'X-Api-Key')).toBe(WAF_MASKED_HEADER_VALUE);
  });

  it('keeps header names so an admin can still see what the request carried', () => {
    const masked = maskWafRequestHeaders([{ name: 'x-api-key', value: 'the-secret-value' }]);

    expect(masked[0].name).toBe('x-api-key');
  });

  it('handles an empty header list', () => {
    expect(maskWafRequestHeaders([])).toEqual([]);
  });
});

describe('isWafDiagnosticHeader', () => {
  it('rejects a header whose name merely contains a diagnostic name', () => {
    expect(isWafDiagnosticHeader('host')).toBe(true);
    expect(isWafDiagnosticHeader('x-host-token')).toBe(false);
  });
});
