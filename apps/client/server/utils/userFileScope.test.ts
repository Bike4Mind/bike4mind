import { describe, it, expect } from 'vitest';
import { ApiKeyScope, getDataLakeTags } from '@bike4mind/common';
import { buildUserFileScope, buildRequestFileScope } from './userFileScope';

// `Opti` is the requiredUserTag of the only lake in the DATA_LAKES registry; without it the
// derived set is empty and every assertion here would pass vacuously.
const GRANTING_TAG = 'Opti';
const GRANTED_LAKE_TAG = 'datalake:opti-knowledge';

describe('buildUserFileScope', () => {
  it('derives lake tags from the registry rather than forwarding the raw user tags', () => {
    const scope = buildUserFileScope({ groups: [], tags: [GRANTING_TAG, 'some-arbitrary-tag'] });

    expect(scope.dataLakeTags).toContain(GRANTED_LAKE_TAG);
    expect(scope.dataLakeTags).not.toContain('some-arbitrary-tag');
    expect(scope.dataLakeTags).not.toContain(GRANTING_TAG);
  });

  // dataLakeTags is an ownership-bypass arm downstream, so a caller holding no gating tag must
  // widen the counted set by nothing at all.
  it('grants no lake scope to a caller without the gating tag', () => {
    expect(buildUserFileScope({ groups: [], tags: ['some-arbitrary-tag'] }).dataLakeTags).toEqual([]);
  });

  it('passes the caller groups through', () => {
    expect(buildUserFileScope({ groups: ['group-a', 'group-b'], tags: [] }).userGroups).toEqual(['group-a', 'group-b']);
  });

  it('defaults absent groups and tags to empty rather than undefined', () => {
    expect(buildUserFileScope({})).toEqual({ userGroups: [], dataLakeTags: getDataLakeTags([]) });
  });

  // IUserDocument types both fields as nullable, and a persisted record really can hold null.
  it('treats an explicit null the same as absent', () => {
    expect(buildUserFileScope({ groups: null, tags: null })).toEqual({
      userGroups: [],
      dataLakeTags: getDataLakeTags([]),
    });
  });
});

describe('buildRequestFileScope', () => {
  const USER = { groups: ['group-a'], tags: [GRANTING_TAG, 'some-arbitrary-tag'] };

  it('gives a JWT caller (no apiKeyInfo) the full scope', () => {
    const scope = buildRequestFileScope({}, USER);

    expect(scope.dataLakeTags).toEqual(getDataLakeTags(USER.tags));
    expect(scope.dataLakeTags).toContain(GRANTED_LAKE_TAG);
  });

  it('drops the lake tags for a key holding only files:read, and still passes the user groups through', () => {
    const scope = buildRequestFileScope({ apiKeyInfo: { scopes: [ApiKeyScope.READ_FILES] } }, USER);

    expect(scope.dataLakeTags).toEqual([]);
    expect(scope.userGroups).toEqual(['group-a']);
  });

  it('keeps the full scope for a key holding datalake:read', () => {
    const scope = buildRequestFileScope(
      { apiKeyInfo: { scopes: [ApiKeyScope.READ_FILES, ApiKeyScope.DATALAKE_READ] } },
      USER
    );

    expect(scope.dataLakeTags).toEqual(getDataLakeTags(USER.tags));
  });
});
