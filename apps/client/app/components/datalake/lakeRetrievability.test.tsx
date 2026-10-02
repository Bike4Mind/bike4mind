import { describe, it, expect } from 'vitest';
import { DATA_LAKES } from '@bike4mind/common';
import {
  isUnsearchable,
  isUnsearchableInNewTestSession,
  UNSEARCHABLE_LAKE_REASON,
  unsearchableLakeReason,
} from './lakeRetrievability';
import { DRAFT_LAKE_TOOLTIP } from './lakeVisibility';

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

describe('unsearchableLakeReason', () => {
  it('blames the draft state before access, since an owner reads false on their own draft', () => {
    expect(unsearchableLakeReason({ id: 'd', status: 'draft' })).toBe(DRAFT_LAKE_TOOLTIP);
    expect(unsearchableLakeReason({ id: 'legacy' })).toBe(DRAFT_LAKE_TOOLTIP);
    expect(unsearchableLakeReason({ id: 'a', status: 'active' })).toBe(UNSEARCHABLE_LAKE_REASON);
    expect(unsearchableLakeReason({ id: DATA_LAKES[0].id })).toBe(UNSEARCHABLE_LAKE_REASON);
  });
});
