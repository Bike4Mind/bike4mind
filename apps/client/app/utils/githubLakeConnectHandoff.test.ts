import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearGitHubLakeConnectHandoff,
  readGitHubLakeConnectHandoff,
  saveGitHubLakeConnectHandoff,
} from './githubLakeConnectHandoff';

const HANDOFF = { dataLakeId: 'lake1' };

beforeEach(() => {
  sessionStorage.clear();
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
});
