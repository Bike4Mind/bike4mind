import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const { createLog, getClientIp, recordSessionReuseRevoked, recordSessionRecovered } = vi.hoisted(() => ({
  createLog: vi.fn(),
  getClientIp: vi.fn(),
  recordSessionReuseRevoked: vi.fn(),
  recordSessionRecovered: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({ userAuthAuditLogRepository: { createLog } }));
vi.mock('@bike4mind/server-utils/utils/ip', () => ({ getClientIp }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ recordSessionReuseRevoked, recordSessionRecovered }));

import { logAuthAudit } from './authAudit';

const req = { headers: { 'user-agent': 'UA/2' }, requestId: 'req-1' } as unknown as Request;

describe('logAuthAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('records that a reusing request came from the issuing IP', async () => {
    getClientIp.mockReturnValue('203.0.113.7');
    await logAuthAudit(req, {
      userId: 'user-1',
      event: 'session_reuse_revoked',
      metadata: { sid: 'sid-1', issuedIp: '203.0.113.7' },
    });

    expect(createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorIp: '203.0.113.7',
        userAgent: 'UA/2',
        metadata: { sid: 'sid-1', issuedIp: '203.0.113.7', requestIpMatchesIssuedIp: true },
      })
    );
    expect(console.warn).toHaveBeenCalledWith(
      '[auth] session_reuse_revoked',
      expect.objectContaining({ userId: 'user-1', actorIp: '203.0.113.7', userAgent: 'UA/2', sid: 'sid-1' })
    );
    expect(recordSessionReuseRevoked).toHaveBeenCalledOnce();
  });

  it('records a mismatch when the reusing request came from elsewhere', async () => {
    getClientIp.mockReturnValue('198.51.100.9');
    await logAuthAudit(req, {
      userId: 'user-1',
      event: 'session_reuse_revoked',
      metadata: { issuedIp: '203.0.113.7' },
    });

    expect(createLog.mock.calls[0][0].metadata).toMatchObject({ requestIpMatchesIssuedIp: false });
  });

  it('omits the comparison when either IP is unknown', async () => {
    getClientIp.mockReturnValue(null);
    await logAuthAudit(req, {
      userId: 'user-1',
      event: 'session_reuse_revoked',
      metadata: { issuedIp: '203.0.113.7' },
    });
    getClientIp.mockReturnValue('203.0.113.7');
    await logAuthAudit(req, { userId: 'user-1', event: 'session_reuse_revoked', metadata: { issuedIp: null } });

    for (const [entry] of createLog.mock.calls) {
      expect(entry.metadata).not.toHaveProperty('requestIpMatchesIssuedIp');
    }
  });

  it('leaves other events untouched and unlogged', async () => {
    getClientIp.mockReturnValue('203.0.113.7');
    await logAuthAudit(req, { userId: 'user-1', event: 'session_recovered', metadata: { issuedIp: '203.0.113.7' } });

    expect(createLog.mock.calls[0][0].metadata).toEqual({ issuedIp: '203.0.113.7' });
    expect(console.warn).not.toHaveBeenCalled();
    expect(recordSessionRecovered).toHaveBeenCalledOnce();
  });
});
