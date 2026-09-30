import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DATA_LAKES } from '@bike4mind/common';

const listDataLakesMock = vi.fn();
vi.mock('../../../../dataLakeService/listDataLakes', () => ({
  listDataLakes: (...args: unknown[]) => listDataLakesMock(...args),
}));

import { listMyDataLakesTool } from './listMyDataLakes';
import { NOT_AVAILABLE_MESSAGE, DATA_LAKES_DISABLED_MESSAGE } from './adapters';
import type { ToolContext } from '../../base/types';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

function lake(overrides: Record<string, unknown> = {}) {
  return { id: 'lake1', name: 'Research', canManage: true, isOwn: true, status: 'active', ...overrides };
}

function makeContext({
  isAdmin = false,
  enabled = true,
  withLakeAdapter = true,
}: { isAdmin?: boolean; enabled?: boolean; withLakeAdapter?: boolean } = {}): ToolContext {
  return {
    userId: 'u1',
    user: { id: 'u1', isAdmin },
    logger,
    statusUpdate: vi.fn().mockResolvedValue(undefined),
    db: {
      dataLakes: withLakeAdapter ? { findAccessible: vi.fn() } : {},
      dataLakeAccessGrants: {},
      organizations: {
        findMembershipOrgIds: vi.fn().mockResolvedValue([]),
        findIdsWithAdminRights: vi.fn().mockResolvedValue([]),
      },
      adminSettings: { getSettingsValue: vi.fn().mockResolvedValue(enabled) },
    },
  } as unknown as ToolContext;
}

const run = (context: ToolContext) =>
  listMyDataLakesTool.implementation(context, undefined).toolFn({}) as Promise<string>;

describe('list_my_data_lakes', () => {
  beforeEach(() => {
    listDataLakesMock.mockReset();
  });

  it('lists writable lakes with id, status and scope', async () => {
    listDataLakesMock.mockResolvedValue([
      lake(),
      lake({ id: 'lake2', name: 'Drafty', status: 'draft', organizationId: 'org1' }),
    ]);

    const result = await run(makeContext());

    expect(result).toContain('(2)');
    expect(result).toContain('- Research (id: lake1) - active - searchable; personal lake');
    expect(result).toContain('- Drafty (id: lake2) - draft - not searchable until published');
    expect(result).toContain('organization lake');
  });

  it('drops lakes the caller cannot manage, built-in lakes and archived lakes', async () => {
    listDataLakesMock.mockResolvedValue([
      lake({ id: 'readonly', name: 'ReadOnly', canManage: false }),
      lake({ id: DATA_LAKES[0].id, name: 'BuiltIn' }),
      lake({ id: 'old', name: 'Archived', status: 'archived' }),
      lake({ id: 'keep', name: 'Keeper' }),
    ]);

    const result = await run(makeContext());

    expect(result).toContain('Keeper');
    expect(result).not.toContain('ReadOnly');
    expect(result).not.toContain('BuiltIn');
    expect(result).not.toContain('Archived');
  });

  it('restricts a platform admin to lakes they own', async () => {
    listDataLakesMock.mockResolvedValue([
      lake({ id: 'mine', name: 'Mine' }),
      lake({ id: 'theirs', name: 'Theirs', isOwn: false }),
    ]);

    const result = await run(makeContext({ isAdmin: true }));

    expect(result).toContain('Mine');
    expect(result).not.toContain('Theirs');
  });

  it('points at create_data_lake when nothing is writable', async () => {
    listDataLakesMock.mockResolvedValue([lake({ canManage: false })]);

    await expect(run(makeContext())).resolves.toContain('create_data_lake');
  });

  it('refuses when the lake adapters are not wired on this surface', async () => {
    await expect(run(makeContext({ withLakeAdapter: false }))).resolves.toBe(NOT_AVAILABLE_MESSAGE);
    expect(listDataLakesMock).not.toHaveBeenCalled();
  });

  it('refuses when data lakes are disabled', async () => {
    await expect(run(makeContext({ enabled: false }))).resolves.toBe(DATA_LAKES_DISABLED_MESSAGE);
    expect(listDataLakesMock).not.toHaveBeenCalled();
  });

  it('returns a safe message instead of the raw error when listing fails', async () => {
    listDataLakesMock.mockRejectedValue(new Error('connection reset by peer at 10.0.0.1'));

    const result = await run(makeContext());

    expect(result).toContain('Could not list');
    expect(result).not.toContain('10.0.0.1');
  });
});
