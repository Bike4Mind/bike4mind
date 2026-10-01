import { describe, it, expect } from 'vitest';
import { isUnsearchable, isUnsearchableInNewTestSession } from './lakeRetrievability';

describe('isUnsearchable', () => {
  it('marks only an explicit retrievable === false from the server', () => {
    expect(isUnsearchable({ id: 'l1', retrievable: true })).toBe(false);
    expect(isUnsearchable({ id: 'l1', retrievable: undefined })).toBe(false);
    expect(isUnsearchable({ id: 'l1', retrievable: false })).toBe(true);
  });
});

describe('isUnsearchableInNewTestSession', () => {
  it('exempts a lake session-create will pre-authorize, and only that', () => {
    expect(isUnsearchableInNewTestSession({ id: 'l1', retrievable: false, canPreauthorize: true })).toBe(false);
    expect(isUnsearchableInNewTestSession({ id: 'l1', retrievable: false, canPreauthorize: false })).toBe(true);
    expect(isUnsearchableInNewTestSession({ id: 'l1', retrievable: true, canPreauthorize: false })).toBe(false);
  });
});
