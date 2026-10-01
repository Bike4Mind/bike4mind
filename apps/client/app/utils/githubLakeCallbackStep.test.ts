import { describe, it, expect } from 'vitest';
import { RESTART_MESSAGE, resolveGitHubLakeCallbackStep } from './githubLakeCallbackStep';

const handoff = { dataLakeId: 'lake1' };

describe('resolveGitHubLakeCallbackStep', () => {
  it('starts the authorize exchange when GitHub returns code and state', () => {
    expect(resolveGitHubLakeCallbackStep({ code: 'c1', state: 's1' }, handoff)).toEqual({
      kind: 'authorize',
      dataLakeId: 'lake1',
      state: 's1',
      code: 'c1',
    });
  });

  it('reopens the picker with no server call when the install fallback returns with an installation id but no code', () => {
    expect(resolveGitHubLakeCallbackStep({ installation_id: '42', state: 's1' }, handoff)).toEqual({
      kind: 'resume',
      dataLakeId: 'lake1',
    });
  });

  it('reopens the picker on a setup_action update/install return with no code', () => {
    expect(resolveGitHubLakeCallbackStep({ setup_action: 'update', state: 's1' }, handoff)).toEqual({
      kind: 'resume',
      dataLakeId: 'lake1',
    });
  });

  it('explains an install that is waiting on a GitHub org owner, with a notice to refresh later', () => {
    expect(resolveGitHubLakeCallbackStep({ setup_action: 'request', state: 's1' }, handoff)).toEqual({
      kind: 'resume',
      dataLakeId: 'lake1',
      notice: expect.stringMatching(/organization owner/),
    });
  });

  it('reads a declined authorize as a cancel', () => {
    expect(resolveGitHubLakeCallbackStep({ error: 'access_denied', state: 's1' }, handoff)).toEqual({
      kind: 'cancelled',
    });
  });

  it.each([
    ['another GitHub error', { error: 'redirect_uri_mismatch', state: 's1' }, handoff],
    ['no handoff (a different tab, or storage cleared)', { code: 'c1', state: 's1' }, null],
    ['a code with no state', { code: 'c1' }, handoff],
    ['nothing at all', {}, handoff],
  ])('fails with %s', (_name, search, h) => {
    expect(resolveGitHubLakeCallbackStep(search, h)).toEqual({ kind: 'failed', message: RESTART_MESSAGE });
  });
});
