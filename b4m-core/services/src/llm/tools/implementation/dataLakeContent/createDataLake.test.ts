import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestError, MAX_TAG_PREFIX_LENGTH } from '@bike4mind/common';

const createDataLakeMock = vi.fn();
vi.mock('../../../../dataLakeService/createDataLake', () => ({
  createDataLake: (...args: unknown[]) => createDataLakeMock(...args),
}));

import { createDataLakeTool, prefixCandidate } from './createDataLake';
import { NOT_AVAILABLE_MESSAGE, DATA_LAKES_DISABLED_MESSAGE } from './adapters';
import type { ToolContext } from '../../base/types';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeContext({
  organizationId,
  memberOf = [],
  enabled = true,
  withAdapters = true,
}: { organizationId?: string; memberOf?: string[]; enabled?: boolean; withAdapters?: boolean } = {}): ToolContext {
  return {
    userId: 'u1',
    user: { id: 'u1' },
    organizationId,
    logger,
    statusUpdate: vi.fn().mockResolvedValue(undefined),
    db: {
      dataLakes: withAdapters ? { create: vi.fn() } : {},
      dataLakeAccessGrants: withAdapters ? { upsertGrant: vi.fn() } : {},
      organizations: {
        findMembershipOrgIds: vi.fn().mockResolvedValue(memberOf),
        findIdsWithAdminRights: vi.fn().mockResolvedValue([]),
      },
      adminSettings: { getSettingsValue: vi.fn().mockResolvedValue(enabled) },
    },
  } as unknown as ToolContext;
}

const run = (context: ToolContext, args: unknown) =>
  createDataLakeTool.implementation(context, undefined).toolFn(args) as Promise<string>;

describe('create_data_lake', () => {
  beforeEach(() => {
    createDataLakeMock.mockReset();
  });

  it('creates a personal draft lake with the wizard slug and prefix, and says it is a DRAFT', async () => {
    createDataLakeMock.mockResolvedValue({ id: 'lake9', name: 'Research Notes' });

    const result = await run(makeContext(), { name: 'Research Notes', description: 'Q3 work' });

    expect(createDataLakeMock).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ name: 'Research Notes', slug: 'research-notes', description: 'Q3 work' }),
      expect.anything(),
      undefined
    );
    expect(createDataLakeMock.mock.calls[0][1].fileTagPrefix).toMatch(/:$/);
    expect(result).toContain('id: lake9');
    expect(result).toContain('DRAFT');
    expect(result).toContain('personal');
    expect(result).toContain('save_content_to_data_lake');
  });

  it('scopes the lake to the active org when the caller is a member', async () => {
    createDataLakeMock.mockResolvedValue({ id: 'lake9', name: 'Team', organizationId: 'org1' });

    const result = await run(makeContext({ organizationId: 'org1', memberOf: ['org1'] }), { name: 'Team' });

    expect(createDataLakeMock.mock.calls[0][3]).toBe('org1');
    expect(result).toContain('shared with the active organization');
  });

  it('refuses an active org the caller does not belong to', async () => {
    const result = await run(makeContext({ organizationId: 'org-x', memberOf: ['org1'] }), { name: 'Team' });

    expect(result).toContain('could not be created in the active organization');
    expect(result).toContain('Data Lakes manager');
    expect(result).not.toMatch(/not a member|does not belong/i);
    expect(createDataLakeMock).not.toHaveBeenCalled();
  });

  it('retries with a disambiguated prefix when the first one collides', async () => {
    createDataLakeMock
      .mockRejectedValueOnce(new BadRequestError('Tag prefix "research:" overlaps the lake "Other"'))
      .mockResolvedValueOnce({ id: 'lake9', name: 'Research' });

    const result = await run(makeContext(), { name: 'Research' });

    expect(createDataLakeMock).toHaveBeenCalledTimes(2);
    const [first, second] = createDataLakeMock.mock.calls.map(call => call[1].fileTagPrefix);
    expect(second).toBe(prefixCandidate(first, 1));
    expect(second).not.toBe(first);
    expect(result).toContain('id: lake9');
  });

  it('retries on a collision thrown by a different copy of BadRequestError (matched by name)', async () => {
    const foreign = Object.assign(new Error('Tag prefix "research:" is reserved'), {
      name: 'BadRequestError',
      statusCode: 400,
    });
    createDataLakeMock.mockRejectedValueOnce(foreign).mockResolvedValueOnce({ id: 'lake9', name: 'Research' });

    const result = await run(makeContext(), { name: 'Research' });

    expect(createDataLakeMock).toHaveBeenCalledTimes(2);
    expect(result).toContain('id: lake9');
  });

  it('passes through a 4xx message from a foreign error copy', async () => {
    const foreign = Object.assign(new Error('Slug already taken'), { name: 'BadRequestError', statusCode: 400 });
    createDataLakeMock.mockRejectedValue(foreign);

    await expect(run(makeContext(), { name: 'Research' })).resolves.toBe(
      'The data lake was not created: Slug already taken.'
    );
  });

  it('gives up after repeated collisions without creating anything', async () => {
    createDataLakeMock.mockRejectedValue(new BadRequestError('Tag prefix "research:" is reserved'));

    const result = await run(makeContext(), { name: 'Research' });

    expect(createDataLakeMock).toHaveBeenCalledTimes(5);
    expect(result).toContain('Could not find a free tag prefix');
  });

  it('does not retry an unrelated failure and hides server internals', async () => {
    createDataLakeMock.mockRejectedValue(new Error('E11000 duplicate key on host db-1'));

    const result = await run(makeContext(), { name: 'Research' });

    expect(createDataLakeMock).toHaveBeenCalledTimes(1);
    expect(result).toBe('The data lake was not created: an unexpected server error.');
  });

  it('passes a 4xx message through', async () => {
    createDataLakeMock.mockRejectedValue(new BadRequestError('A lake with slug "research" already exists'));

    await expect(run(makeContext(), { name: 'Research' })).resolves.toContain('already exists');
  });

  it('rejects a name with too few letters or digits', async () => {
    const result = await run(makeContext(), { name: '!!' });

    expect(result).toContain('at least');
    expect(createDataLakeMock).not.toHaveBeenCalled();
  });

  it('rejects missing arguments', async () => {
    await expect(run(makeContext(), {})).resolves.toContain('Invalid parameters');
  });

  it('refuses when the create adapters are not wired', async () => {
    await expect(run(makeContext({ withAdapters: false }), { name: 'Research' })).resolves.toBe(NOT_AVAILABLE_MESSAGE);
  });

  it('refuses when data lakes are disabled', async () => {
    await expect(run(makeContext({ enabled: false }), { name: 'Research' })).resolves.toBe(DATA_LAKES_DISABLED_MESSAGE);
    expect(createDataLakeMock).not.toHaveBeenCalled();
  });
});

describe('prefixCandidate', () => {
  it('keeps the base prefix on the first attempt', () => {
    expect(prefixCandidate('acme:', 0)).toBe('acme:');
  });

  it('suffixes later attempts', () => {
    expect(prefixCandidate('acme:', 1)).toBe('acme-2:');
    expect(prefixCandidate('acme:', 4)).toBe('acme-5:');
  });

  it('stays within the maximum prefix length', () => {
    const base = `${'a'.repeat(MAX_TAG_PREFIX_LENGTH - 1)}:`;
    const candidate = prefixCandidate(base, 3);

    expect(candidate.length).toBeLessThanOrEqual(MAX_TAG_PREFIX_LENGTH);
    expect(candidate.endsWith('-4:')).toBe(true);
  });
});
