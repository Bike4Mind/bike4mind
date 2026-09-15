import { describe, it, expect } from 'vitest';
import { HttpStatus } from '@bike4mind/common';
import { assertNoForbiddenMcpEnvKeys } from './mcpEnvValidation';

const status = (fn: () => unknown): number | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { statusCode?: number }).statusCode;
  }
};

describe('assertNoForbiddenMcpEnvKeys', () => {
  it('accepts a well-formed provider variable set', () => {
    expect(() =>
      assertNoForbiddenMcpEnvKeys([
        { key: 'NOTION_ACCESS_TOKEN', value: 'secret_x' },
        { key: 'NOTION_WRITE_ENABLED', value: 'true' },
      ])
    ).not.toThrow();
  });

  it('accepts an empty set', () => {
    expect(() => assertNoForbiddenMcpEnvKeys([])).not.toThrow();
  });

  it.each([
    ['NODE_OPTIONS', '--require /tmp/payload.js'],
    ['NODE_EXTRA_CA_CERTS', '/tmp/ca.pem'],
    ['LD_PRELOAD', '/tmp/evil.so'],
    ['HTTPS_PROXY', 'http://attacker.example'],
    ['PATH', '/tmp/bin'],
  ])('rejects %s with a 400', (key, value) => {
    const call = () =>
      assertNoForbiddenMcpEnvKeys([
        { key: 'NOTION_ACCESS_TOKEN', value: 'ok' },
        { key, value },
      ]);

    expect(call).toThrow(/Rejected MCP environment variable/);
    expect(status(call)).toBe(HttpStatus.BadRequest);
  });

  it('names the offending key without echoing its value', () => {
    try {
      assertNoForbiddenMcpEnvKeys([{ key: 'NODE_OPTIONS', value: '--require /tmp/payload.js' }]);
      throw new Error('expected a rejection');
    } catch (error) {
      const reason = String((error as { additionalInfo?: { reason?: string } }).additionalInfo?.reason);
      expect(reason).toContain('NODE_OPTIONS');
      expect(reason).not.toContain('/tmp/payload.js');
    }
  });
});
