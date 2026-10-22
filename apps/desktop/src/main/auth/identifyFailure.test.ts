import { describe, expect, it } from 'vitest';
import { SessionRevokedError } from '@bike4mind/client-auth';
import { classifyIdentifyFailure } from './identifyFailure';

function httpError(status: number, data: unknown, message = 'Request failed') {
  return Object.assign(new Error(message), { response: { status, data } });
}

describe('classifyIdentifyFailure', () => {
  it('reads a 403 policy gate as its own state, not a sign-in failure', () => {
    const failure = classifyIdentifyFailure(
      httpError(403, {
        error: 'Policy acceptance required.',
        error_description: 'Accept the Terms of Service and Acceptable Use Policy to continue.',
        policyAcceptanceRequired: true,
      })
    );

    expect(failure.outcome).toBe('policy-acceptance-required');
    expect(failure.error.remedy).toBe('accept-policy');
    expect(failure.error.message).toContain('Acceptable Use Policy');
  });

  it('reads a 401 mfaPending as its own state, not a sign-in failure', () => {
    const failure = classifyIdentifyFailure(
      httpError(401, { error: 'MFA setup or verification required.', mfaPending: true })
    );

    expect(failure.outcome).toBe('mfa-required');
    expect(failure.error.remedy).toBe('complete-mfa');
    expect(failure.error.message).toBe('MFA setup or verification required.');
  });

  it('treats a plain 401 as a revoked session', () => {
    const failure = classifyIdentifyFailure(httpError(401, { error: 'Unauthorized' }));

    expect(failure.outcome).toBe('signed-out');
    expect(failure.error.remedy).toBe('retry-sign-in');
  });

  it('treats SessionRevokedError as a revoked session and keeps its message', () => {
    const failure = classifyIdentifyFailure(new SessionRevokedError('Your session expired. Sign in again.'));

    expect(failure.outcome).toBe('signed-out');
    expect(failure.error.message).toBe('Your session expired. Sign in again.');
  });

  it('keeps the session for a 5xx or a network failure', () => {
    expect(classifyIdentifyFailure(httpError(503, { error: 'nope' })).outcome).toBe('transient');
    expect(classifyIdentifyFailure(new Error('getaddrinfo ENOTFOUND')).outcome).toBe('transient');
    expect(classifyIdentifyFailure(undefined).outcome).toBe('transient');
  });

  it('does not mistake a 403 without the policy flag for the policy gate', () => {
    expect(classifyIdentifyFailure(httpError(403, { error: 'Forbidden' })).outcome).toBe('transient');
  });
});
