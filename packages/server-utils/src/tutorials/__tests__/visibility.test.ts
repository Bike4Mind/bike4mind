import { describe, it, expect, vi, beforeEach } from 'vitest';

const userHasEntitlement = vi.hoisted(() => vi.fn());
vi.mock('../../entitlements/index', () => ({ userHasEntitlement }));

import { coreTutorialVisibleTo, filterCoreTutorialsVisibleTo } from '../visibility';

const KEY = 'tutorials:pro';
const gated = { entitlement: KEY } as const;
const user = (extra: Record<string, unknown> = {}) => ({ id: 'u1', isAdmin: false, tags: [], ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  userHasEntitlement.mockResolvedValue(false);
});

describe('coreTutorialVisibleTo', () => {
  it('denies a user without the entitlement', async () => {
    await expect(coreTutorialVisibleTo(user(), gated)).resolves.toBe(false);
    expect(userHasEntitlement).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), KEY);
  });

  it('allows a user with the entitlement', async () => {
    userHasEntitlement.mockResolvedValue(true);
    await expect(coreTutorialVisibleTo(user(), gated)).resolves.toBe(true);
  });

  it('allows an admin', async () => {
    await expect(coreTutorialVisibleTo(user({ isAdmin: true }), gated)).resolves.toBe(true);
  });

  it('allows a developer without consulting entitlements', async () => {
    await expect(coreTutorialVisibleTo(user({ tags: ['developer'] }), gated)).resolves.toBe(true);
    expect(userHasEntitlement).not.toHaveBeenCalled();
  });

  it('always allows a public tutorial', async () => {
    await expect(coreTutorialVisibleTo(user(), { public: true })).resolves.toBe(true);
    expect(userHasEntitlement).not.toHaveBeenCalled();
  });
});

describe('filterCoreTutorialsVisibleTo', () => {
  const tutorials = [
    { id: 'open', visibility: { public: true } as const },
    { id: 'locked', visibility: gated },
  ];

  it('drops what the user may not see and keeps order', async () => {
    const result = await filterCoreTutorialsVisibleTo(user(), tutorials);
    expect(result.map(t => t.id)).toEqual(['open']);
  });

  it('keeps everything for a developer', async () => {
    const result = await filterCoreTutorialsVisibleTo(user({ tags: ['developer'] }), tutorials);
    expect(result.map(t => t.id)).toEqual(['open', 'locked']);
  });
});
