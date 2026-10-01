import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearGitHubLakeConnectHandoff,
  readGitHubLakeConnectHandoff,
  saveGitHubLakeConnectHandoff,
} from './githubLakeConnectHandoff';

const HANDOFF = { dataLakeId: 'lake1', authorizeUrl: 'https://github.com/login/oauth/authorize?state=s1' };

beforeEach(() => {
  sessionStorage.clear();
});

describe('githubLakeConnectHandoff', () => {
  it('round-trips a handoff and clears it', () => {
    saveGitHubLakeConnectHandoff({ ...HANDOFF, installationId: 42 });
    expect(readGitHubLakeConnectHandoff()).toEqual({ ...HANDOFF, installationId: 42 });

    clearGitHubLakeConnectHandoff();
    expect(readGitHubLakeConnectHandoff()).toBeNull();
  });

  it.each([
    ['not JSON', '{oops'],
    ['the wrong shape', JSON.stringify({ dataLakeId: 'lake1' })],
    ['a non-URL authorizeUrl', JSON.stringify({ dataLakeId: 'lake1', authorizeUrl: 'nope' })],
  ])('reads %s as no handoff', (_name, raw) => {
    sessionStorage.setItem('b4m:github-lake-connect', raw);
    expect(readGitHubLakeConnectHandoff()).toBeNull();
  });
});
