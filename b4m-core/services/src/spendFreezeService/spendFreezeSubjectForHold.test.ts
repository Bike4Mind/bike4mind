import { describe, expect, it } from 'vitest';
import { spendFreezeSubjectForHold } from './spendFreezeSubjectForHold';

describe('spendFreezeSubjectForHold', () => {
  it('carries the user, the billed organization and the key', () => {
    expect(spendFreezeSubjectForHold({ userId: 'u1', organizationId: 'o1', apiKeyId: 'k1' })).toEqual({
      userId: 'u1',
      organizationId: 'o1',
      apiKeyId: 'k1',
    });
  });

  it('carries the user when there is no key', () => {
    expect(spendFreezeSubjectForHold({ userId: 'u1', organizationId: null })).toEqual({
      userId: 'u1',
      organizationId: null,
      apiKeyId: undefined,
    });
  });
});
