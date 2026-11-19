import { describe, it, expect, vi } from 'vitest';
import { SIDE_APP_MINT_OUR_FAULT_EVENT } from '@bike4mind/server-utils/auth/sideAppMintEvent';
const recordSideAppRefusal = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/server-utils/auth/sideAppRefusal', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/auth/sideAppRefusal')>()),
  recordSideAppRefusal,
}));

import { logAndRecordSideAppMintRefusal, logOAuthError } from './oauthErrorLog';

const lineFor = (clientId: unknown) => {
  const warn = vi.fn();
  logOAuthError({ warn }, { route: 'oauth/token', clientId, error: 'invalid_grant', status: 400 });
  expect(warn).toHaveBeenCalledTimes(1);
  return String(warn.mock.calls[0][0]);
};

describe('logOAuthError', () => {
  it('emits one key=value line with exactly the four fields', () => {
    expect(lineFor('client-1')).toBe('[OAUTH_ERROR] route=oauth/token client=client-1 error=invalid_grant status=400');
  });

  it('strips characters that could forge or split a log line', () => {
    expect(lineFor('a\nb c\r[OAUTH_ERROR]')).toContain('client=abcOAUTH_ERROR error=');
  });

  it('caps an oversized client at 128 chars', () => {
    expect(lineFor('x'.repeat(500))).toContain(`client=${'x'.repeat(128)} error=`);
  });

  it.each([undefined, null, 42, { id: 'c' }, ['c'], '\n\n'])('logs %j as client=unknown', clientId => {
    expect(lineFor(clientId)).toContain('client=unknown error=');
  });

  it('never throws, with no logger or a throwing one', () => {
    const args = { route: 'r', clientId: 'c', error: 'e', status: 400 };
    expect(() => logOAuthError(undefined, args)).not.toThrow();
    expect(() =>
      logOAuthError(
        {
          warn: () => {
            throw new Error('boom');
          },
        },
        args
      )
    ).not.toThrow();
  });
});

describe('logAndRecordSideAppMintRefusal', () => {
  const base = { route: 'oauth/ai-token', error: 'invalid_client', status: 401 };

  it('logs the line and records a mint refusal with the verification flag it was given', () => {
    const warn = vi.fn();
    logAndRecordSideAppMintRefusal({ warn }, { ...base, clientId: 'client-1', verified: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(recordSideAppRefusal).toHaveBeenCalledWith({
      verified: false,
      clientId: 'client-1',
      stage: 'mint',
      reason: 'invalid_client',
      status: 401,
      userId: undefined,
    });
  });

  it('passes no client id when the claim is not a string', () => {
    logAndRecordSideAppMintRefusal(undefined, { ...base, clientId: { id: 1 }, verified: false });
    expect(recordSideAppRefusal).toHaveBeenLastCalledWith(expect.objectContaining({ clientId: undefined }));
  });

  it('emits the dedicated event line beside the log line for our-fault refusals only', () => {
    const warn = vi.fn();
    logAndRecordSideAppMintRefusal(
      { warn },
      { ...base, error: 'server_error', status: 500, clientId: 'c', verified: true }
    );
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(SIDE_APP_MINT_OUR_FAULT_EVENT, { route: 'oauth/ai-token', status: 500 });

    const appFault = vi.fn();
    logAndRecordSideAppMintRefusal({ warn: appFault }, { ...base, clientId: 'c', verified: true });
    expect(appFault).toHaveBeenCalledTimes(1);
  });

  it('classifies by the recorded reason when it differs from the wire error', () => {
    const warn = vi.fn();
    logAndRecordSideAppMintRefusal(
      { warn },
      {
        ...base,
        error: 'temporarily_unavailable',
        recordAs: 'rate_limited',
        status: 429,
        clientId: 'c',
        verified: true,
      }
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
