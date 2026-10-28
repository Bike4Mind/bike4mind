import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { setupMongoTest } from '../../../__test__/utils';
import { AdminSavedView, adminSavedViewRepository } from './AdminSavedViewModel';

const ADA = new Types.ObjectId().toHexString();
const GRACE = new Types.ObjectId().toHexString();
const VIEW = { version: 1, params: { status: 'suspended' } };

const create = (ownerId: string, name: string, shared = false) =>
  adminSavedViewRepository.create({ ownerId, surface: 'users', name, shared, view: VIEW });

describe('AdminSavedViewRepository', () => {
  setupMongoTest();

  it('lists the owner views and other admins shared views, by name', async () => {
    await create(ADA, 'Zeta');
    await create(ADA, 'Alpha');
    await create(GRACE, 'Grace shared', true);
    await create(GRACE, 'Grace personal');

    const visible = await adminSavedViewRepository.listVisible(ADA, 'users', { owned: 50, shared: 50 });
    expect(visible.map(view => view.name)).toEqual(['Alpha', 'Grace shared', 'Zeta']);
    expect(visible[0]).toMatchObject({ ownerId: ADA, surface: 'users', shared: false, view: VIEW });
  });

  it('keeps the owner views when shared views fill the shared bound', async () => {
    await create(ADA, 'Zeta', true);
    await create(GRACE, 'Alpha', true);
    await create(GRACE, 'Beta', true);
    await create(GRACE, 'Gamma', true);

    const visible = await adminSavedViewRepository.listVisible(ADA, 'users', { owned: 50, shared: 2 });
    expect(visible.map(view => view.name)).toEqual(['Alpha', 'Beta', 'Zeta']);
  });

  it('rejects a duplicate name for the same owner but not for another admin', async () => {
    // The unique index is the guard, and the test DB does not build it on its own.
    await AdminSavedView.createIndexes();
    await create(ADA, 'Mine');
    await expect(create(ADA, ' Mine ')).rejects.toMatchObject({ code: 11000 });
    await expect(create(GRACE, 'Mine')).resolves.toMatchObject({ ownerId: GRACE });
    expect(await adminSavedViewRepository.countOwned(ADA, 'users')).toBe(1);
  });

  it('updates and deletes only the owner view', async () => {
    const view = await create(ADA, 'Mine');
    expect(await adminSavedViewRepository.updateOwned(view.id, GRACE, { name: 'Stolen' })).toBeNull();
    expect(await adminSavedViewRepository.deleteOwned(view.id, GRACE)).toBe(false);

    const renamed = await adminSavedViewRepository.updateOwned(view.id, ADA, { name: '  Renamed ', shared: true });
    expect(renamed).toMatchObject({ name: 'Renamed', shared: true });
    expect(await adminSavedViewRepository.deleteOwned(view.id, ADA)).toBe(true);
    expect(await AdminSavedView.countDocuments()).toBe(0);
  });

  it('declares the unique name index and the shared-list index', async () => {
    await AdminSavedView.createIndexes();
    const indexes = await AdminSavedView.collection.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { ownerId: 1, surface: 1, name: 1 }, unique: true }),
        expect.objectContaining({ key: { surface: 1, shared: 1 } }),
      ])
    );
  });
});
