import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn();
vi.mock('@bike4mind/database', () => ({
  AdminSettings: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}));

import migration from './20260710160000_base-entitlement-cover-drifted-seed-configs';

// Returns the settingValue array the migration wrote via updateOne (last call).
const writtenConfigs = () => mockUpdateOne.mock.calls.at(-1)?.[1]?.settingValue;

describe('base-entitlement-cover-drifted-seed-configs migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  it('adds base to customer-bearing drifted seeds the first pass missed (keeping tags)', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'doc1',
      settingValue: [
        // pre-opti 3-tag seed - the dominant prod shape the exact-match pass skipped
        { id: 'm-analyst3', enabled: true, allowedUserTags: ['analyst', 'customer', 'developer'] },
        { id: 'm-custdev', enabled: true, allowedUserTags: ['customer', 'developer'] },
        { id: 'm-custonly', enabled: true, allowedUserTags: ['Customer'] }, // case-insensitive
      ],
    });

    await migration.up();

    const configs = writtenConfigs();
    for (const id of ['m-analyst3', 'm-custdev', 'm-custonly']) {
      expect(configs.find((c: any) => c.id === id).allowedEntitlements).toEqual(['base']);
    }
    // tags are preserved, not rewritten
    expect(configs.find((c: any) => c.id === 'm-analyst3').allowedUserTags).toEqual([
      'analyst',
      'customer',
      'developer',
    ]);
  });

  it('leaves customer-less gates alone (deliberate restriction never seen by baseline users)', async () => {
    // The key safety property: a model an operator restricted to developers-only (customer
    // removed) must NOT become public - on B4M prod or a self-host install.
    mockFindOne.mockResolvedValue({
      _id: 'doc1',
      settingValue: [
        { id: 'm-devonly', enabled: true, allowedUserTags: ['developer'] },
        { id: 'm-analystdev', enabled: true, allowedUserTags: ['analyst', 'developer'] },
        { id: 'm-optionly', enabled: true, allowedUserTags: ['opti'] },
      ],
    });

    await migration.up();

    // None contain `customer` -> nothing matched -> no write at all.
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('leaves custom tags, existing entitlements, and empty tags untouched', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'doc1',
      settingValue: [
        { id: 'm-custom', enabled: true, allowedUserTags: ['customer', 'contractor'] }, // custom tag alongside customer
        {
          id: 'm-ent',
          enabled: true,
          allowedUserTags: ['customer', 'developer'],
          allowedEntitlements: ['medlib:pro'], // real entitlement gate - never made public
        },
        { id: 'm-empty', enabled: true, allowedUserTags: [] }, // genuinely ungated (fail-closed) - left alone
      ],
    });

    await migration.up();

    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('is idempotent - configs already carrying base (from the first pass) are skipped', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'doc1',
      settingValue: [
        {
          id: 'm',
          enabled: true,
          allowedUserTags: ['analyst', 'customer', 'developer', 'opti'],
          allowedEntitlements: ['base'],
        },
      ],
    });

    await migration.up();

    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('adds base to a disabled customer-bearing seed (enabled still gates visibility)', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'doc1',
      settingValue: [{ id: 'm-off', enabled: false, allowedUserTags: ['customer', 'developer'] }],
    });

    await migration.up();

    expect(writtenConfigs().find((c: any) => c.id === 'm-off').allowedEntitlements).toEqual(['base']);
  });

  it('no-ops when the settings doc is absent', async () => {
    mockFindOne.mockResolvedValue(null);

    await migration.up();

    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('no-ops when settingValue exists but is not an array', async () => {
    mockFindOne.mockResolvedValue({ _id: 'doc1', settingValue: { not: 'an array' } });

    await migration.up();

    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('down removes base only from customer-bearing seeds it created', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'doc1',
      settingValue: [
        { id: 'm-seed', enabled: true, allowedUserTags: ['customer', 'developer'], allowedEntitlements: ['base'] },
        { id: 'm-public', enabled: true, allowedUserTags: [], allowedEntitlements: ['base'] },
        { id: 'm-devonly', enabled: true, allowedUserTags: ['developer'], allowedEntitlements: ['base'] },
      ],
    });

    await migration.down();

    const configs = writtenConfigs();
    expect(configs.find((c: any) => c.id === 'm-seed').allowedEntitlements).toBeUndefined();
    // empty-tag public and customer-less (dev-only) base grants are NOT ours to revert
    expect(configs.find((c: any) => c.id === 'm-public').allowedEntitlements).toEqual(['base']);
    expect(configs.find((c: any) => c.id === 'm-devonly').allowedEntitlements).toEqual(['base']);
  });
});
