import { describe, it, expect, vi } from 'vitest';
import type { ISuspiciousPattern } from '@bike4mind/database';

vi.mock('@bike4mind/database', () => ({ authFailLogRepository: {}, connectDB: vi.fn(), userRepository: {} }));
vi.mock('@bike4mind/server-utils/utils/logger', () => ({ contextToLogs: vi.fn() }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: vi.fn() } } }));
vi.mock('sst', () => ({ Resource: {} }));

const { formatSecurityAlert } = await import('./alertProcessor');

const pattern: ISuspiciousPattern = {
  _id: { ip: '10.0.0.1', timeBucket: new Date() },
  ip: '<i>10.0.0.1</i>',
  attempts: 6,
  usernames: ['someone'],
  strategies: ['local', '<s>other</s>'],
  reasons: [],
  firstAttempt: new Date(),
  lastAttempt: new Date(),
  riskLevel: 'high',
};

describe('formatSecurityAlert', () => {
  it('escapes the username, IP and strategy names in the body', () => {
    const html = formatSecurityAlert(pattern, '<b>x</b>', 'x@example.com');

    expect(html).toContain('Dear &lt;b&gt;x&lt;/b&gt;,');
    expect(html).toContain('&lt;i&gt;10.0.0.1&lt;/i&gt;');
    expect(html).toContain('local, &lt;s&gt;other&lt;/s&gt;');
    expect(html).not.toContain('<b>x</b>');
  });
});
