import { describe, it, expect } from 'vitest';
import { assertSafeApiPath } from '../apiPath';

describe('assertSafeApiPath', () => {
  it.each([
    '/issue/PROJ-123/watchers',
    '/content/123456/child/attachment',
    `/group/${encodeURIComponent('Release Managers / EMEA')}`,
    '/issue/PROJ-1.2/comment',
  ])('accepts %s', path => {
    expect(() => assertSafeApiPath(path)).not.toThrow();
  });

  it.each([
    ['a query string', '/issue/PROJ-1?expand=x/watchers'],
    ['a fragment', '/issue/PROJ-1#/watchers'],
    ['a backslash', '/issue/PROJ-1\\..\\project/watchers'],
    ['a parent segment', '/issue/../project/PROJ/watchers'],
    ['a current segment', '/issue/./PROJ-1/watchers'],
    ['an encoded parent segment', '/issue/%2E%2e/project/watchers'],
    ['a mixed-encoding parent segment', '/issue/.%2e/project/watchers'],
    ['a parent segment with a path parameter', '/issue/..;x/project/watchers'],
    ['an encoded parent segment with a path parameter', '/issue/%2E.;jsessionid=1/project/watchers'],
    ['a tab that would collapse into a parent segment', '/issue/.\t./project/watchers'],
    ['a newline', '/issue/PROJ-1\n/watchers'],
    ['a space', '/issue/PROJ 1/watchers'],
  ])('rejects a path containing %s', (_label, path) => {
    expect(() => assertSafeApiPath(path)).toThrow('Invalid API path');
  });
});
