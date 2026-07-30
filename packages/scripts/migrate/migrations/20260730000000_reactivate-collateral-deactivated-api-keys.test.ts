import { describe, it, expect, vi, beforeEach } from 'vitest';

type Filter = Record<string, unknown>;

// Mock the model the migration reaches for its two queries. The signatures are explicit so
// the assertions below can index mock.calls.
const mockDistinct = vi.fn<(field: string, filter: Filter) => Promise<string[]>>();
const mockLean = vi.fn<() => Promise<unknown[]>>();
const mockSelect = vi.fn<(fields: string) => { lean: typeof mockLean }>(() => ({ lean: mockLean }));
const mockFind = vi.fn<(filter: Filter) => { select: typeof mockSelect }>(() => ({ select: mockSelect }));
const mockUpdateMany = vi.fn<(filter: Filter, update: Filter) => Promise<{ modifiedCount: number }>>();
vi.mock('@bike4mind/database', () => ({
  ApiKey: {
    distinct: (field: string, filter: Filter) => mockDistinct(field, filter),
    find: (filter: Filter) => mockFind(filter),
    updateMany: (filter: Filter, update: Filter) => mockUpdateMany(filter, update),
  },
}));

import migration, { selectKeysToReactivate } from './20260730000000_reactivate-collateral-deactivated-api-keys';

const NOW = new Date('2026-07-30T00:00:00Z');
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const key = (over: Partial<Parameters<typeof selectKeysToReactivate>[0][number]> = {}) => ({
  _id: 'k1',
  userId: 'u1',
  type: 'openAi',
  isActive: false,
  expiresAt: day(30),
  createdAt: day(-10),
  ...over,
});

describe('selectKeysToReactivate', () => {
  it('reactivates the stranded key of a provider that has none active', () => {
    const keys = [
      key({ _id: 'openai', type: 'openAi', isActive: true }),
      key({ _id: 'elevenlabs', type: 'elevenLabs', isActive: false }),
    ];

    expect(selectKeysToReactivate(keys, NOW)).toEqual(['elevenlabs']);
  });

  it('leaves a provider that already has an active key alone', () => {
    const keys = [
      key({ _id: 'current', isActive: true, createdAt: day(-1) }),
      key({ _id: 'superseded', isActive: false, createdAt: day(-9) }),
    ];

    expect(selectKeysToReactivate(keys, NOW)).toEqual([]);
  });

  it('picks the newest of several stranded keys for the same provider', () => {
    const keys = [
      key({ _id: 'old', createdAt: day(-30) }),
      key({ _id: 'newest', createdAt: day(-2) }),
      key({ _id: 'middle', createdAt: day(-10) }),
    ];

    expect(selectKeysToReactivate(keys, NOW)).toEqual(['newest']);
  });

  it('skips a provider whose only stranded keys are expired', () => {
    const keys = [key({ _id: 'expired-a', expiresAt: day(-1) }), key({ _id: 'expired-b', expiresAt: day(-40) })];

    expect(selectKeysToReactivate(keys, NOW)).toEqual([]);
  });

  it('skips the newest key when it is expired and takes the newest live one instead', () => {
    const keys = [
      key({ _id: 'newest-expired', createdAt: day(-1), expiresAt: day(-1) }),
      key({ _id: 'older-live', createdAt: day(-20), expiresAt: day(60) }),
    ];

    expect(selectKeysToReactivate(keys, NOW)).toEqual(['older-live']);
  });

  it('treats a missing expiresAt as live, matching keyOrExpired', () => {
    const keys = [key({ _id: 'no-expiry', expiresAt: null })];

    expect(selectKeysToReactivate(keys, NOW)).toEqual(['no-expiry']);
  });

  it('handles each provider of one user independently', () => {
    const keys = [
      key({ _id: 'openai-active', type: 'openAi', isActive: true }),
      key({ _id: 'elevenlabs-stranded', type: 'elevenLabs' }),
      key({ _id: 'voyage-stranded', type: 'voyageai' }),
    ];

    expect(selectKeysToReactivate(keys, NOW).sort()).toEqual(['elevenlabs-stranded', 'voyage-stranded']);
  });

  it('never mixes users holding the same provider', () => {
    const keys = [
      key({ _id: 'u1-active', userId: 'u1', isActive: true }),
      key({ _id: 'u2-stranded', userId: 'u2', isActive: false }),
    ];

    expect(selectKeysToReactivate(keys, NOW)).toEqual(['u2-stranded']);
  });

  it('is deterministic when createdAt ties', () => {
    const tied = [key({ _id: 'aaa', createdAt: day(-5) }), key({ _id: 'zzz', createdAt: day(-5) })];

    expect(selectKeysToReactivate(tied, NOW)).toEqual(selectKeysToReactivate([...tied].reverse(), NOW));
  });

  it('returns nothing for an empty collection', () => {
    expect(selectKeysToReactivate([], NOW)).toEqual([]);
  });
});

describe('reactivate-collateral-deactivated-api-keys migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateMany.mockResolvedValue({ modifiedCount: 1 });
  });

  it('reads only live keys of owners who hold an inactive one, then reactivates the selection', async () => {
    mockDistinct.mockResolvedValue(['u1']);
    mockLean.mockResolvedValue([
      { _id: 'openai', userId: 'u1', type: 'openAi', isActive: true, expiresAt: day(30), createdAt: day(-2) },
      { _id: 'elevenlabs', userId: 'u1', type: 'elevenLabs', isActive: false, expiresAt: day(30), createdAt: day(-2) },
    ]);

    await migration.up();

    expect(mockDistinct).toHaveBeenCalledWith('userId', { deletedAt: null, isActive: false });
    expect(mockFind).toHaveBeenCalledWith({ deletedAt: null, userId: { $in: ['u1'] } });
    expect(mockUpdateMany).toHaveBeenCalledWith({ _id: { $in: ['elevenlabs'] } }, { $set: { isActive: true } });
  });

  it('excludes soft-deleted keys from both queries', async () => {
    mockDistinct.mockResolvedValue(['u1']);
    mockLean.mockResolvedValue([]);

    await migration.up();

    expect(mockDistinct.mock.calls[0][1]).toMatchObject({ deletedAt: null });
    expect(mockFind.mock.calls[0][0]).toMatchObject({ deletedAt: null });
  });

  it('writes nothing when no user holds an inactive key', async () => {
    mockDistinct.mockResolvedValue([]);

    await migration.up();

    expect(mockFind).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('writes nothing when every provider already has an active key', async () => {
    mockDistinct.mockResolvedValue(['u1']);
    mockLean.mockResolvedValue([
      { _id: 'current', userId: 'u1', type: 'openAi', isActive: true, expiresAt: day(30), createdAt: day(-1) },
      { _id: 'superseded', userId: 'u1', type: 'openAi', isActive: false, expiresAt: day(30), createdAt: day(-9) },
    ]);

    await migration.up();

    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('down is a no-op (irreversible)', async () => {
    await migration.down();

    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});
