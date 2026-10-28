import { describe, it, expect } from 'vitest';
import { impersonationDecision } from './impersonationGate';

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
  ])('always refuses %s even after escalation', path => {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(impersonationDecision(method, path, true)).toBe('sensitive');
    }
  });
  it('does not assume an unreviewed GET is a read', () => {
    expect(impersonationDecision('GET', '/api/files/f/do-something', false)).toBe('readonly');
  });
  it('allows reviewed reads and explicit escalation but rejects ordinary writes by default', () => {
    expect(impersonationDecision('GET', '/api/identify?x=1', false)).toBe('allow');
    expect(impersonationDecision('POST', '/api/files', false)).toBe('readonly');
    expect(impersonationDecision('POST', '/api/files', true)).toBe('allow');
    expect(impersonationDecision('POST', '/api/auth/impersonation', false)).toBe('allow');
  });
});
