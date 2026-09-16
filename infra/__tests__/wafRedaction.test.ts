/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { WAF_REDACTED_HEADERS } from '../wafRedaction';
import { isWafDiagnosticHeader } from '../../apps/client/server/security/wafHeaderRedaction';

describe('WAF_REDACTED_HEADERS', () => {
  it('covers every credential-bearing header the app authenticates with', () => {
    // Kept in step with the inbound auth headers read under apps/client/pages/api and
    // apps/client/server. A new one belongs here before it reaches a route.
    for (const header of [
      'authorization',
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
    ]) {
      expect(WAF_REDACTED_HEADERS).toContain(header);
    }
  });

  it('names headers in the lowercase form WAF matches on', () => {
    for (const header of WAF_REDACTED_HEADERS) {
      expect(header).toBe(header.toLowerCase());
    }
  });

  it('holds no duplicates, which WAF rejects as a duplicate redacted field', () => {
    expect(new Set(WAF_REDACTED_HEADERS).size).toBe(WAF_REDACTED_HEADERS.length);
  });

  it('stays within the 100 redacted fields AWS allows per logging configuration', () => {
    expect(WAF_REDACTED_HEADERS.length).toBeLessThanOrEqual(100);
  });

  it('shares no header with the admin dashboard diagnostic allowlist', () => {
    // The two lists are complements: a header worth redacting at write time must never be one the
    // admin blocked-requests API serves verbatim at read time.
    const overlap = WAF_REDACTED_HEADERS.filter(isWafDiagnosticHeader);
    expect(overlap).toEqual([]);
  });
});
