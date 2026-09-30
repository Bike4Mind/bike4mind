import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DATA_LAKES, FabFileSourceType, ForbiddenError } from '@bike4mind/common';

const assertLakeAccessWithGrantsMock = vi.fn();
vi.mock('../../../../dataLakeService/assertLakeAccess', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../dataLakeService/assertLakeAccess')>()),
  assertLakeAccessWithGrants: (...args: unknown[]) => assertLakeAccessWithGrantsMock(...args),
}));
const canManageLakeMock = vi.fn();
vi.mock('../../../../dataLakeService/manageRule', () => ({
  canManageLake: (...args: unknown[]) => canManageLakeMock(...args),
}));
const addFileToDataLakeMock = vi.fn();
vi.mock('../../../../dataLakeService/addFileToDataLake', () => ({
  addFileToDataLake: (...args: unknown[]) => addFileToDataLakeMock(...args),
}));
const createFabFileMock = vi.fn();
vi.mock('../../../../fabFileService/create', () => ({
  createFabFile: (...args: unknown[]) => createFabFileMock(...args),
}));

import { resolveFileNameAndType, saveContentToDataLakeTool } from './saveContentToDataLake';
import { NOT_AVAILABLE_MESSAGE, DATA_LAKES_DISABLED_MESSAGE } from './adapters';
import type { ToolContext } from '../../base/types';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const activeLake = { id: 'lake1', name: 'Research', status: 'active' };

function makeContext({ enabled = true, withAudit = true }: { enabled?: boolean; withAudit?: boolean } = {}) {
  const statusUpdate = vi.fn().mockResolvedValue(undefined);
  const context = {
    userId: 'u1',
    user: { id: 'u1' },
    logger,
    statusUpdate,
    storage: { upload: vi.fn(), getSignedUrl: vi.fn() },
    db: {
      dataLakes: {
        findBySlug: vi.fn(),
        findBySlugAmongIds: vi.fn(),
        setStats: vi.fn(),
        activateIfDraft: vi.fn(),
      },
      dataLakeAccessGrants: { listByLake: vi.fn() },
      fabfiles: {},
      users: {},
      scopedSettings: {},
      lakeMembershipRemovals: {},
      ...(withAudit ? { lakeConfigChangeEvents: {}, lakeMembershipChangeEvents: {} } : {}),
      organizations: {
        findMembershipOrgIds: vi.fn().mockResolvedValue([]),
        findIdsWithAdminRights: vi.fn().mockResolvedValue(['org1']),
      },
      adminSettings: { getSettingsValue: vi.fn().mockResolvedValue(enabled) },
    },
  } as unknown as ToolContext;
  return { context, statusUpdate };
}

const baseArgs = { content: '# Notes\nhello', fileName: 'notes.md', dataLakeId: 'lake1' };
const run = (context: ToolContext, args: unknown = baseArgs) =>
  saveContentToDataLakeTool.implementation(context, undefined).toolFn(args) as Promise<string>;

describe('save_content_to_data_lake', () => {
  beforeEach(() => {
    assertLakeAccessWithGrantsMock.mockReset().mockResolvedValue({ lake: activeLake, grants: [] });
    canManageLakeMock.mockReset().mockReturnValue(true);
    createFabFileMock.mockReset().mockResolvedValue({ id: 'file1' });
    addFileToDataLakeMock.mockReset().mockResolvedValue(undefined);
  });

  it('creates a user file with no session and manual provenance, then adds it to the lake', async () => {
    const { context, statusUpdate } = makeContext();

    const result = await run(context);

    const [userId, input, deps] = createFabFileMock.mock.calls[0];
    expect(userId).toBe('u1');
    expect(input).toMatchObject({ fileName: 'notes.md', mimeType: 'text/markdown', fileSize: 13 });
    expect(input).not.toHaveProperty('sessionId');
    expect(Buffer.isBuffer(input.content)).toBe(true);
    expect(deps.provenance).toEqual({ sourceType: FabFileSourceType.MANUAL_UPLOAD });
    expect(deps.administeredOrgIds).toEqual(['org1']);
    expect(addFileToDataLakeMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      'lake1',
      'file1',
      expect.anything()
    );
    expect(statusUpdate).toHaveBeenCalledWith({}, 'Saving notes.md to Research...');
    expect(result).toContain('Saved "notes.md" to the data lake "Research" (file id: file1)');
    expect(result).not.toContain('DRAFT');
  });

  it('warns that a draft lake is not searchable yet', async () => {
    assertLakeAccessWithGrantsMock.mockResolvedValue({ lake: { ...activeLake, status: 'draft' }, grants: [] });
    const { context } = makeContext();

    await expect(run(context)).resolves.toContain('still a DRAFT');
  });

  it('creates no file when the lake is not accessible', async () => {
    assertLakeAccessWithGrantsMock.mockRejectedValue(new ForbiddenError('You do not have access to this data lake'));
    const { context } = makeContext();

    const result = await run(context);

    expect(result).toContain('Nothing was saved: You do not have access to this data lake');
    expect(createFabFileMock).not.toHaveBeenCalled();
  });

  it('creates no file when the caller can read but not manage the lake', async () => {
    canManageLakeMock.mockReturnValue(false);
    const { context } = makeContext();

    await expect(run(context)).resolves.toContain('cannot add files');
    expect(createFabFileMock).not.toHaveBeenCalled();
  });

  it('creates no file for a built-in lake', async () => {
    assertLakeAccessWithGrantsMock.mockResolvedValue({ lake: { ...activeLake, id: DATA_LAKES[0].id }, grants: [] });
    const { context } = makeContext();

    await expect(run(context)).resolves.toContain('Nothing was saved');
    expect(createFabFileMock).not.toHaveBeenCalled();
  });

  it('creates no file for an archived lake', async () => {
    assertLakeAccessWithGrantsMock.mockResolvedValue({ lake: { ...activeLake, status: 'archived' }, grants: [] });
    const { context } = makeContext();

    await expect(run(context)).resolves.toContain('is archived');
    expect(createFabFileMock).not.toHaveBeenCalled();
  });

  it('reports a partial save honestly when the add fails after the file was created', async () => {
    addFileToDataLakeMock.mockRejectedValue(new Error('write conflict at shard-3'));
    const { context } = makeContext();

    const result = await run(context);

    expect(result).toContain('Partially saved');
    expect(result).toContain('file id: file1');
    expect(result).toContain('NOT added');
    expect(result).not.toContain('shard-3');
  });

  it('reports nothing saved when the file create fails', async () => {
    createFabFileMock.mockRejectedValue(new Error('S3 timeout'));
    const { context } = makeContext();

    const result = await run(context);

    expect(result).toBe('Nothing was saved: an unexpected server error.');
    expect(addFileToDataLakeMock).not.toHaveBeenCalled();
  });

  it('refuses when an audit sink is not wired', async () => {
    const { context } = makeContext({ withAudit: false });

    await expect(run(context)).resolves.toBe(NOT_AVAILABLE_MESSAGE);
    expect(createFabFileMock).not.toHaveBeenCalled();
  });

  it('refuses when data lakes are disabled', async () => {
    const { context } = makeContext({ enabled: false });

    await expect(run(context)).resolves.toBe(DATA_LAKES_DISABLED_MESSAGE);
    expect(assertLakeAccessWithGrantsMock).not.toHaveBeenCalled();
  });

  it('rejects a mime type outside the text allowlist', async () => {
    const { context } = makeContext();

    await expect(run(context, { ...baseArgs, mimeType: 'application/pdf' })).resolves.toContain('Invalid parameters');
    expect(createFabFileMock).not.toHaveBeenCalled();
  });
});

describe('resolveFileNameAndType', () => {
  it('defaults to markdown and appends the extension', () => {
    expect(resolveFileNameAndType('notes')).toEqual({ fileName: 'notes.md', mimeType: 'text/markdown' });
  });

  it('infers the type from a known extension', () => {
    expect(resolveFileNameAndType('data.CSV')).toEqual({ fileName: 'data.CSV', mimeType: 'text/csv' });
    expect(resolveFileNameAndType('page.htm')).toEqual({ fileName: 'page.htm', mimeType: 'text/html' });
  });

  it('replaces a recognized extension that disagrees with an explicit type', () => {
    expect(resolveFileNameAndType('report.txt', 'application/json')).toEqual({
      fileName: 'report.json',
      mimeType: 'application/json',
    });
    expect(resolveFileNameAndType('notes.md', 'text/csv')).toEqual({ fileName: 'notes.csv', mimeType: 'text/csv' });
    expect(resolveFileNameAndType('page.html', 'text/markdown')).toEqual({
      fileName: 'page.md',
      mimeType: 'text/markdown',
    });
  });

  it('keeps an extension the allowlist does not know and appends the right one', () => {
    expect(resolveFileNameAndType('v1.2')).toEqual({ fileName: 'v1.2.md', mimeType: 'text/markdown' });
  });

  it('falls back to a default base name when only an extension is given', () => {
    expect(resolveFileNameAndType('.md')).toEqual({ fileName: 'untitled.md', mimeType: 'text/markdown' });
    expect(resolveFileNameAndType('...')).toEqual({ fileName: 'untitled.md', mimeType: 'text/markdown' });
  });

  it('strips path separators', () => {
    expect(resolveFileNameAndType('../etc/passwd.txt').fileName).toBe('..-etc-passwd.txt');
  });
});
