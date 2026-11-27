import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminSavedViewRecord, IAdminSavedViewRepository } from '@bike4mind/database';
import {
  CreateAdminSavedViewRequestSchema,
  UpdateAdminSavedViewRequestSchema,
} from '@client/app/utils/adminSavedViews';
import { createSavedView, deleteSavedView, listSavedViews, updateSavedView, type SavedViewsDeps } from './savedViews';

const ADMIN = 'a'.repeat(24);
const OTHER = 'b'.repeat(24);
const VIEW = { version: 1, params: { status: 'suspended', sortField: 'name', sortOrder: 'asc', limit: 50 } };

const record = (overrides: Partial<AdminSavedViewRecord> = {}): AdminSavedViewRecord => ({
  id: 'c'.repeat(24),
  ownerId: ADMIN,
  surface: 'users',
  name: 'Suspended by name',
  shared: false,
  view: VIEW,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

const duplicateKey = () => Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });

let repository: { [K in keyof IAdminSavedViewRepository]: ReturnType<typeof vi.fn> };
let deps: SavedViewsDeps;
const warn = vi.fn();

beforeEach(() => {
  warn.mockReset();
  repository = {
    listVisible: vi.fn(async () => []),
    countOwned: vi.fn(async () => 0),
    create: vi.fn(async input => record(input)),
    updateOwned: vi.fn(async () => record()),
    deleteOwned: vi.fn(async () => true),
  };
  deps = { repository: repository as unknown as IAdminSavedViewRepository, logger: { warn } };
});

describe('listSavedViews', () => {
  it('marks ownership and skips (and logs) a view of an unknown or invalid version', async () => {
    repository.listVisible.mockResolvedValue([
      record({ id: '1'.repeat(24) }),
      record({ id: '2'.repeat(24), ownerId: OTHER, shared: true }),
      record({ id: '3'.repeat(24), view: { version: 2, params: {} } }),
      record({ id: '4'.repeat(24), view: { version: 1, params: { limit: 7 } } }),
    ]);
    const views = await listSavedViews(ADMIN, 'users', deps);

    expect(repository.listVisible).toHaveBeenCalledWith(ADMIN, 'users', { owned: 50, shared: 50 });
    expect(views.map(view => [view.id[0], view.isOwner])).toEqual([
      ['1', true],
      ['2', false],
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ viewId: '3'.repeat(24), reason: 'unknown-version', version: 2 })
    );
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: 'invalid' }));
  });
});

describe('createSavedView', () => {
  const request = CreateAdminSavedViewRequestSchema.parse({ surface: 'users', name: '  Mine ', view: VIEW });

  it('creates a personal view by default', async () => {
    const created = await createSavedView(ADMIN, request, deps);
    expect(repository.create).toHaveBeenCalledWith({
      ownerId: ADMIN,
      surface: 'users',
      name: 'Mine',
      shared: false,
      view: VIEW,
    });
    expect(created).toMatchObject({ name: 'Mine', isOwner: true, shared: false });
  });

  it('answers 409 for a name the admin already uses', async () => {
    repository.create.mockRejectedValue(duplicateKey());
    await expect(createSavedView(ADMIN, request, deps)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('answers 400 once the admin holds the cap', async () => {
    repository.countOwned.mockResolvedValue(50);
    await expect(createSavedView(ADMIN, request, deps)).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe('updateSavedView', () => {
  it('passes only the fields being changed, owner-scoped', async () => {
    await updateSavedView(ADMIN, 'c'.repeat(24), UpdateAdminSavedViewRequestSchema.parse({ shared: true }), deps);
    expect(repository.updateOwned).toHaveBeenCalledWith('c'.repeat(24), ADMIN, { shared: true });
  });

  it('answers 404 when the view is not the caller own (including another admin shared view)', async () => {
    repository.updateOwned.mockResolvedValue(null);
    await expect(updateSavedView(OTHER, 'c'.repeat(24), { name: 'Mine' }, deps)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('rejects an invalid replacement view and a taken name', async () => {
    await expect(
      updateSavedView(ADMIN, 'c'.repeat(24), { view: { version: 9, params: {} } }, deps)
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.updateOwned).not.toHaveBeenCalled();

    repository.updateOwned.mockRejectedValue(duplicateKey());
    await expect(updateSavedView(ADMIN, 'c'.repeat(24), { name: 'Taken' }, deps)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe('deleteSavedView', () => {
  it('deletes the owner view and answers 404 otherwise', async () => {
    await expect(deleteSavedView(ADMIN, 'c'.repeat(24), deps)).resolves.toBeUndefined();
    repository.deleteOwned.mockResolvedValue(false);
    await expect(deleteSavedView(OTHER, 'c'.repeat(24), deps)).rejects.toMatchObject({ statusCode: 404 });
  });
});
