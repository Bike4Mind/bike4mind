import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  clearGitHubLakeConnectHandoff,
  readGitHubLakeConnectHandoff,
  saveGitHubLakeConnectHandoff,
} from './githubLakeConnectHandoff';
import { GITHUB_LAKE_CALLBACK_PATH } from './githubLakeCallbackSearch';

const HANDOFF = { dataLakeId: 'lake1' };

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('githubLakeConnectHandoff', () => {
  it('round-trips a handoff and clears it', () => {
    saveGitHubLakeConnectHandoff(HANDOFF);
    expect(readGitHubLakeConnectHandoff()).toEqual(HANDOFF);

    clearGitHubLakeConnectHandoff();
    expect(readGitHubLakeConnectHandoff()).toBeNull();
  });

  it.each([
    ['not JSON', '{oops'],
    ['the wrong shape', JSON.stringify({})],
    ['an empty dataLakeId', JSON.stringify({ dataLakeId: '' })],
  ])('reads %s as no handoff', (_name, raw) => {
    sessionStorage.setItem('b4m:github-lake-connect', raw);
    expect(readGitHubLakeConnectHandoff()).toBeNull();
  });

  it('records the current path, query and hash as the return path', () => {
    window.history.replaceState(null, '', '/projects/p1?tab=files#x');
    saveGitHubLakeConnectHandoff(HANDOFF);
    expect(readGitHubLakeConnectHandoff()).toEqual({ ...HANDOFF, returnPath: '/projects/p1?tab=files#x' });
  });

  it.each([
    ['the callback page', GITHUB_LAKE_CALLBACK_PATH],
    ['the root', '/'],
  ])('records no return path from %s', (_name, path) => {
    window.history.replaceState(null, '', path);
    saveGitHubLakeConnectHandoff(HANDOFF);
    expect(readGitHubLakeConnectHandoff()).toEqual(HANDOFF);
  });

  it('reads a handoff saved before the return path existed', () => {
    sessionStorage.setItem('b4m:github-lake-connect', JSON.stringify({ dataLakeId: 'lake1' }));
    expect(readGitHubLakeConnectHandoff()).toEqual(HANDOFF);
  });
});
