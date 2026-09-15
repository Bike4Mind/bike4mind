import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn();
vi.mock('@bike4mind/database', () => ({
  AdminSettings: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}));

import migration from './20260709130000_base-entitlement-on-default-models';

// Returns the settingValue array the migration wrote via updateOne (last call).
const writtenConfigs = () => mockUpdateOne.mock.calls.at(-1)?.[1]?.settingValue;

describe('base-entitlement-on-default-models migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  it('adds base to default-seed configs (3-tag and legacy 4-tag) while keeping their tags', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'doc1',
      settingValue: [
        { id: 'm-three', enabled: true, allowedUserTags: ['developer', 'customer', 'opti'] },
        // legacy seed, mixed case + reordered - matched by normalized set-equality
        { id: 'm-four', enabled: true, allowedUserTags: ['Opti', 'Customer', 'Developer', 'Analyst'] },
      ],
    });

    await migration.up();

    const configs = writtenConfigs();
    expect(configs.find((c: any) => c.id === 'm-three')).toMatchObject({
      allowedUserTags: ['developer', 'customer', 'opti'],
      allowedEntitlements: ['base'],
    });
    expect(configs.find((c: any) => c.id === 'm-four').allowedEntitlements).toEqual(['base']);
  });

  it('leaves deliberate gates untouched (custom tag, subset, or existing entitlement)', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'doc1',
      settingValue: [
        { id: 'm-custom', enabled: true, allowedUserTags: ['developer', 'customer', 'opti', 'contractor'] },
        { id: 'm-subset', enabled: true, allowedUserTags: ['developer'] },
        {
          id: 'm-ent',
          enabled: true,
          allowedUserTags: ['developer', 'customer', 'opti'],
          allowedEntitlements: ['medlib:pro'],
        },
      ],
    });

    await migration.up();

    // Nothing matched -> no write at all.
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('is idempotent - a re-run over already-based configs writes nothing', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'doc1',
      settingValue: [
        { id: 'm', enabled: true, allowedUserTags: ['developer', 'customer', 'opti'], allowedEntitlements: ['base'] },
      ],
    });

    await migration.up();

    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('no-ops when the settings doc is absent', async () => {
    mockFindOne.mockResolvedValue(null);

    await migration.up();

    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('down removes base only from default-seed configs it created', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'doc1',
      settingValue: [
        {
          id: 'm-seed',
          enabled: true,
          allowedUserTags: ['developer', 'customer', 'opti'],
          allowedEntitlements: ['base'],
        },
        { id: 'm-public', enabled: true, allowedUserTags: [], allowedEntitlements: ['base'] },
        {
          id: 'm-ent',
          enabled: true,
          allowedUserTags: ['developer', 'customer', 'opti'],
          allowedEntitlements: ['medlib:pro'],
        },
      ],
    });

    await migration.down();

    const configs = writtenConfigs();
    // seed config reverted (field removed)
    expect(configs.find((c: any) => c.id === 'm-seed').allowedEntitlements).toBeUndefined();
    // a genuinely-public (empty-tag) config and a real entitlement gate are left alone
    expect(configs.find((c: any) => c.id === 'm-public').allowedEntitlements).toEqual(['base']);
    expect(configs.find((c: any) => c.id === 'm-ent').allowedEntitlements).toEqual(['medlib:pro']);
  });
});
