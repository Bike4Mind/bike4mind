import { afterEach, describe, expect, it, vi } from 'vitest';
import { mongoose } from '@bike4mind/database';

const h = vi.hoisted(() => ({ run: vi.fn(async () => []), collections: vi.fn(async () => []) }));

vi.mock('@bike4mind/server-utils/services/publish/purgeUserPublishedArtifacts', () => ({
  purgeUserPublishedArtifacts: vi.fn(async () => undefined),
}));
vi.mock('@bike4mind/server-utils/auth/signupNetworkLimits', () => ({
  retainDeletedSignupTraces: vi.fn(async () => undefined),
}));
vi.mock('./subjectErasureExecutor', () => ({
  SubjectErasureExecutor: class {
    run = h.run;
  },
}));
vi.mock('./subjectErasurePlan', () => ({
  SubjectErasurePlan: class {
    collections = h.collections;
  },
  unerased: (collections: unknown[]) => collections,
}));

import { erasureRegistry } from './erasureRegistry';

const subject = { userId: 'user-1', email: 'person@example.com' };
const assertLease = async () => {};

describe('erasureRegistry with a model the registry does not classify', () => {
  afterEach(() => vi.restoreAllMocks());

  const withExtraModel = () => vi.spyOn(mongoose, 'modelNames').mockReturnValue(['User', 'SyntheticNonCoreModel']);

  it('erases the classified holders instead of refusing', async () => {
    withExtraModel();
    await expect(erasureRegistry.erase(subject, assertLease)).resolves.toBeUndefined();
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('lists the model as unclassified in the audit', async () => {
    withExtraModel();
    await expect(erasureRegistry.audit(subject)).resolves.toEqual({
      remaining: [],
      unclassified: ['SyntheticNonCoreModel'],
    });
  });

  it('still refuses to scope an admin erasure', async () => {
    withExtraModel();
    await expect(erasureRegistry.scope(subject, assertLease)).rejects.toThrow(/SyntheticNonCoreModel/);
  });
});
