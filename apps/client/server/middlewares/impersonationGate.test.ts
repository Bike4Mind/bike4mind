import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
vi.mock('@bike4mind/server-utils/auth/refreshCookie', () => ({
  readAdminReturnCookie: (req: Request) => req.headers.cookie,
}));
import { impersonationDecision, impersonationAnonymousGate } from './impersonationGate';

describe('impersonation route policy', () => {
  it.each([
    '/api/users/u/update',
    '/api/users/u/delete',
    '/api/users/u/loginAs',
    '/api/auth/mfa/setup',
    '/api/auth/mfa/passkey/register',
    '/api/auth/mfa/disable',
    '/api/auth/unlink',
    '/api/auth/step-up',
    '/api/user-api-keys',
    '/api/user-api-keys/k/rotate',
    '/api/admin/users/u/generate-api-key',
    '/api/subscriptions/change',
    '/api/subscriptions/cancel',
    '/api/subscriptions/checkout-session',
    '/api/stripe/portal',
    '/api/stripe/start-payment',
    '/api/oauth/authorize',
    '/api/users/u/%75pdate',
    '/api/email/verify-change',
    '/api/google-drive/token',
    '/api/mcp-connections/connection/api-key',
    '/api/auth/mfa/passkey/register-options',
    '/api/ai/v1/completions',
    '/api/secret-rotations/renewed',
  ])('always refuses %s even after escalation', path => {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(impersonationDecision(method, path, true)).toBe('sensitive');
    }
  });
  it('does not assume an unreviewed GET is a read', () => {
    expect(impersonationDecision('GET', '/api/files/f/do-something', false)).toBe('readonly');
  });
  it('admits only reviewed public reads and recovery with a parked admin cookie', () => {
    const next = vi.fn();
    for (const url of ['/api/settings/logo', '/api/v1/whats-new?limit=5']) {
      impersonationAnonymousGate(
        { method: 'GET', url, headers: { cookie: 'parked' } } as Request,
        {} as Response,
        next
      );
    }
    expect(next).toHaveBeenCalledTimes(2);
    for (const [method, url] of [
      ['POST', '/api/email/verify-change'],
      ['GET', '/api/oauth/authorize'],
      ['POST', '/api/settings/logo'],
    ]) {
      expect(() =>
        impersonationAnonymousGate({ method, url, headers: { cookie: 'parked' } } as Request, {} as Response, next)
      ).toThrow('End support access');
    }
  });
  it('allows reviewed reads and explicit escalation but rejects ordinary writes by default', () => {
    expect(impersonationDecision('GET', '/api/identify?x=1', false)).toBe('allow');
    expect(impersonationDecision('POST', '/api/files', false)).toBe('readonly');
    expect(impersonationDecision('POST', '/api/files', true)).toBe('allow');
    expect(impersonationDecision('POST', '/api/auth/impersonation', false)).toBe('allow');
  });
  it.each([
    '/api/sessions/shared',
    '/api/sessions/count',
    '/api/sessions/favorites',
    '/api/sessions/recent-proactive-messages',
    '/api/sessions/012345678901234567890123/chat',
    '/api/sessions/012345678901234567890123/chat/012345678901234567890124',
    '/api/sessions/012345678901234567890123/agents',
    '/api/settings/fetch',
    '/api/modals',
    '/api/organizations',
    '/api/inbox',
    '/api/invites',
    '/api/projects',
    '/api/models',
    '/api/entitlements',
    '/api/chat-completion-status',
    '/api/users/012345678901234567890123/userInvites',
    '/api/users/012345678901234567890123/friend-requests',
    '/api/users/012345678901234567890123/activities',
    '/api/gears/status',
    '/api/models/stats',
    '/api/help/recently-viewed',
    '/api/v1/video-models',
    '/api/v1/music-models',
  ])('admits notebook navigation without enabling writes: %s', path => {
    expect(impersonationDecision('GET', path, false)).toBe('allow');
    expect(impersonationDecision('POST', path, false)).toBe('readonly');
  });
  it.each([
    '/api/sessions/create',
    '/api/v1/sessions',
    '/api/v1/sessions/012345678901234567890123/clone',
    '/api/sessions/012345678901234567890123/chat',
    '/api/sessions/012345678901234567890123/favorite',
  ])('admits content operations only after escalation: %s', path => {
    expect(impersonationDecision('POST', path, false)).toBe('readonly');
    expect(impersonationDecision('POST', path, true)).toBe('allow');
  });
  it('classifies operations by effects rather than the HTTP verb', () => {
    expect(impersonationDecision('POST', '/api/agents', true)).toBe('sensitive');
    expect(impersonationDecision('PATCH', '/api/agents/012345678901234567890123', true)).toBe('sensitive');
    expect(impersonationDecision('POST', '/api/briefcase/catalog', false)).toBe('allow');
    expect(impersonationDecision('GET', '/api/google-drive/token', false)).toBe('sensitive');
    expect(impersonationDecision('GET', '/api/mcp-servers', true)).toBe('sensitive');
    expect(impersonationDecision('POST', '/api/gears/claim', true)).toBe('readonly');
    expect(impersonationDecision('GET', '/api/notebooks/download', false)).toBe('readonly');
    expect(impersonationDecision('POST', '/api/notebooks/export', false)).toBe('readonly');
    expect(impersonationDecision('POST', '/api/unknown', true)).toBe('readonly');
  });
});
