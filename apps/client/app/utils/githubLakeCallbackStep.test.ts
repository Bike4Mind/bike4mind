import { describe, it, expect } from 'vitest';
import { RESTART_MESSAGE, resolveGitHubLakeCallbackStep } from './githubLakeCallbackStep';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize?client_id=c&state=s1';
const fresh = { dataLakeId: 'lake1', authorizeUrl: AUTHORIZE_URL };
const bounced = { ...fresh, installationId: 42 };

describe('resolveGitHubLakeCallbackStep', () => {
  it('completes a first install, which returns installation_id and code together', () => {
    expect(resolveGitHubLakeCallbackStep({ installation_id: '42', code: 'c1', state: 's1' }, fresh)).toEqual({
      kind: 'complete',
      dataLakeId: 'lake1',
      state: 's1',
      code: 'c1',
      installationId: 42,
    });
  });

  it('bounces an already-installed account through authorize, remembering the installation id', () => {
    expect(resolveGitHubLakeCallbackStep({ installation_id: '42', state: 's1' }, fresh)).toEqual({
      kind: 'authorize',
      authorizeUrl: AUTHORIZE_URL,
      handoff: bounced,
    });
  });

  it('completes the authorize return from the remembered installation id', () => {
    expect(resolveGitHubLakeCallbackStep({ code: 'c2', state: 's1' }, bounced)).toMatchObject({
      kind: 'complete',
      code: 'c2',
      installationId: 42,
    });
  });

  it('never bounces twice: an authorize return with no code fails', () => {
    expect(resolveGitHubLakeCallbackStep({ state: 's1' }, bounced)).toEqual({
      kind: 'failed',
      message: RESTART_MESSAGE,
    });
  });

  it('explains an install that is waiting on a GitHub org owner, rather than asking for a restart', () => {
    expect(resolveGitHubLakeCallbackStep({ setup_action: 'request', state: 's1' }, fresh)).toEqual({
      kind: 'failed',
      message: expect.stringMatching(/approv/),
    });
  });

  it('reads a declined authorize as a cancel', () => {
    expect(resolveGitHubLakeCallbackStep({ error: 'access_denied', state: 's1' }, bounced)).toEqual({
      kind: 'cancelled',
    });
  });

  it.each([
    ['another GitHub error', { error: 'redirect_uri_mismatch', state: 's1' }, fresh],
    ['no state', { installation_id: '42', code: 'c1' }, fresh],
    ['no handoff (a different tab, or storage cleared)', { installation_id: '42', code: 'c1', state: 's1' }, null],
    ['no installation id anywhere', { code: 'c1', state: 's1' }, fresh],
    ['a non-numeric installation id', { installation_id: '42abc', code: 'c1', state: 's1' }, fresh],
    ['a zero installation id', { installation_id: '0', code: 'c1', state: 's1' }, fresh],
  ])('fails with %s', (_name, search, handoff) => {
    expect(resolveGitHubLakeCallbackStep(search, handoff)).toEqual({ kind: 'failed', message: RESTART_MESSAGE });
  });
});
