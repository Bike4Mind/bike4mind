import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import type { PageWidget } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { CustomPage, customPageRepository } from './CustomPageModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await CustomPage.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await CustomPage.deleteMany({}, { hardDelete: true } as Record<string, unknown>);
});

const createPage = async (over: Record<string, unknown> = {}) => {
  const doc = await CustomPage.create({ userId: 'u1', name: 'Daily menu', orchestratorSessionId: 's1', ...over });
  return String(doc._id);
};

const checklist: PageWidget = {
  id: 'shopping-list',
  type: 'checklist',
  items: [
    { id: 'milk', label: 'Milk', checked: false },
    { id: 'eggs', label: 'Eggs', checked: false },
  ],
};

describe('CustomPageModel', () => {
  it('returns an id from create', async () => {
    const created = await customPageRepository.create({
      userId: 'u1',
      name: 'N',
      icon: null,
      description: null,
      state: {},
      widgets: [],
      orchestratorSessionId: 's9',
      version: 0,
      deletedAt: null,
    } as never);
    expect(typeof created.id).toBe('string');
  });

  it('stores an empty state object and version 0 on create', async () => {
    const id = await createPage();
    const page = await customPageRepository.findOwned(id, 'u1');
    expect(page?.id).toBe(id);
    expect(page?.state).toEqual({});
    expect(page?.widgets).toEqual([]);
    expect(page?.version).toBe(0);
  });

  it('scopes every read and write to the owner', async () => {
    const id = await createPage();
    expect(await customPageRepository.findOwned(id, 'u2')).toBeNull();
    expect(await customPageRepository.findByOrchestratorSession('s1', 'u2')).toBeNull();
    expect(await customPageRepository.updateMetaOwned(id, 'u2', { name: 'x' })).toBeNull();
    expect(await customPageRepository.replaceStateOwned(id, 'u2', { a: 1 }, 0)).toBeNull();
    expect(await customPageRepository.upsertWidgetOwned(id, 'u2', checklist, 20)).toBeNull();
    expect(await customPageRepository.softDeleteOwned(id, 'u2')).toBe(false);
    expect((await customPageRepository.listOwned('u2')).length).toBe(0);
    expect((await customPageRepository.findByOrchestratorSession('s1', 'u1'))?.id).toBe(id);
  });

  it('returns null for a malformed id instead of throwing', async () => {
    expect(await customPageRepository.findOwned('nope', 'u1')).toBeNull();
  });

  it('lists pages without state or widgets', async () => {
    const id = await createPage({ state: { secret: 1 }, widgets: [checklist] });
    const [row] = await customPageRepository.listOwned('u1');
    expect(row.id).toBe(id);
    expect(row).not.toHaveProperty('state');
    expect(row).not.toHaveProperty('widgets');
  });

  it('replaces state only at the expected version and bumps it', async () => {
    const id = await createPage();
    const first = await customPageRepository.replaceStateOwned(id, 'u1', { a: 1 }, 0);
    expect(first?.state).toEqual({ a: 1 });
    expect(first?.version).toBe(1);
    expect(await customPageRepository.replaceStateOwned(id, 'u1', { a: 2 }, 0)).toBeNull();
    expect((await customPageRepository.findOwned(id, 'u1'))?.state).toEqual({ a: 1 });
  });

  it('upserts widgets by id and enforces the cap', async () => {
    const id = await createPage();
    await customPageRepository.upsertWidgetOwned(id, 'u1', { id: 'recipe', type: 'markdown', markdown: 'v1' }, 2);
    const replaced = await customPageRepository.upsertWidgetOwned(
      id,
      'u1',
      { id: 'recipe', type: 'markdown', markdown: 'v2' },
      2
    );
    expect(replaced?.widgets).toEqual([{ id: 'recipe', type: 'markdown', markdown: 'v2' }]);
    await customPageRepository.upsertWidgetOwned(id, 'u1', checklist, 2);
    expect(
      await customPageRepository.upsertWidgetOwned(id, 'u1', { id: 'x', type: 'markdown', markdown: '' }, 2)
    ).toBeNull();
    // Replacing an existing widget still works on a full page.
    expect(
      await customPageRepository.upsertWidgetOwned(id, 'u1', { id: 'recipe', type: 'markdown', markdown: 'v3' }, 2)
    ).not.toBeNull();
  });

  it('removes a widget', async () => {
    const id = await createPage({ widgets: [checklist] });
    const page = await customPageRepository.removeWidgetOwned(id, 'u1', 'shopping-list');
    expect(page?.widgets).toEqual([]);
  });

  it('toggles exactly one checklist item via arrayFilters', async () => {
    const id = await createPage({ widgets: [{ id: 'recipe', type: 'markdown', markdown: '' }, checklist] });
    const page = await customPageRepository.setChecklistItemOwned(id, 'u1', 'shopping-list', 'eggs', true);
    const widget = page?.widgets.find(w => w.id === 'shopping-list');
    expect(widget?.type === 'checklist' && widget.items.map(i => i.checked)).toEqual([false, true]);
    expect(await customPageRepository.setChecklistItemOwned(id, 'u1', 'shopping-list', 'nope', true)).toBeNull();
    expect(await customPageRepository.setChecklistItemOwned(id, 'u1', 'recipe', 'eggs', true)).toBeNull();
  });

  it('soft-deletes and then hides the page', async () => {
    const id = await createPage();
    expect(await customPageRepository.softDeleteOwned(id, 'u1')).toBe(true);
    expect(await customPageRepository.findOwned(id, 'u1')).toBeNull();
    expect(await customPageRepository.findByOrchestratorSession('s1', 'u1')).toBeNull();
    expect(await customPageRepository.listOwned('u1')).toEqual([]);
    expect(await customPageRepository.softDeleteOwned(id, 'u1')).toBe(false);
  });
});
