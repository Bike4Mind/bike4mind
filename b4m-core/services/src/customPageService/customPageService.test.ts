import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PAGE_STATE_MAX_BYTES,
  PAGE_SURFACE,
  PAGE_WIDGETS_MAX,
  type ICustomPageDocument,
  type IUserDocument,
  type PageWidget,
} from '@bike4mind/common';

const { mockCreateSession } = vi.hoisted(() => ({ mockCreateSession: vi.fn() }));
vi.mock('../sessionService/create', () => ({ createSession: (...a: unknown[]) => mockCreateSession(...a) }));

import { createPage } from './create';
import { patchState } from './state';
import { setWidget, removeWidget, toggleChecklistItem } from './widgets';
import { buildOrchestratorPrompt } from './orchestratorPrompt';
import type { CreateCustomPageAdapters, CustomPageServiceAdapters } from './ports';

const page = (over: Partial<ICustomPageDocument> = {}): ICustomPageDocument => ({
  id: 'p1',
  userId: 'u1',
  name: 'Daily menu',
  state: {},
  widgets: [],
  orchestratorSessionId: 's1',
  version: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

/** In-memory fake of the repository subset the service uses, with the same owner scoping. */
function fakeRepo(initial: ICustomPageDocument[] = [page()]) {
  const pages = new Map(initial.map(p => [p.id, structuredClone(p)]));
  const owned = (id: string, userId: string) => {
    const found = pages.get(id);
    return found && found.userId === userId && !found.deletedAt ? found : null;
  };
  const repo = {
    findOwned: vi.fn(async (id: string, userId: string) => structuredClone(owned(id, userId))),
    replaceStateOwned: vi.fn(async (id: string, userId: string, state: Record<string, unknown>, expected: number) => {
      const found = owned(id, userId);
      if (!found || found.version !== expected) return null;
      found.state = state;
      found.version += 1;
      return structuredClone(found);
    }),
    upsertWidgetOwned: vi.fn(async (id: string, userId: string, widget: PageWidget, max: number) => {
      const found = owned(id, userId);
      if (!found) return null;
      const index = found.widgets.findIndex(w => w.id === widget.id);
      if (index >= 0) found.widgets[index] = widget;
      else if (found.widgets.length < max) found.widgets.push(widget);
      else return null;
      return structuredClone(found);
    }),
    removeWidgetOwned: vi.fn(async (id: string, userId: string, widgetId: string) => {
      const found = owned(id, userId);
      if (!found) return null;
      found.widgets = found.widgets.filter(w => w.id !== widgetId);
      return structuredClone(found);
    }),
    setChecklistItemOwned: vi.fn(
      async (id: string, userId: string, widgetId: string, itemId: string, checked: boolean) => {
        const found = owned(id, userId);
        const widget = found?.widgets.find(w => w.id === widgetId);
        const item = widget?.type === 'checklist' ? widget.items.find(i => i.id === itemId) : undefined;
        if (!found || !item) return null;
        item.checked = checked;
        return structuredClone(found);
      }
    ),
  };
  return { repo, pages, adapters: { db: { customPages: repo } } satisfies CustomPageServiceAdapters };
}

describe('createPage', () => {
  const user = { id: 'u1' } as IUserDocument;
  let sessionsDelete: ReturnType<typeof vi.fn>;
  let create: ReturnType<typeof vi.fn>;
  let adapters: CreateCustomPageAdapters;

  beforeEach(() => {
    mockCreateSession.mockReset().mockResolvedValue({ id: 's9' });
    sessionsDelete = vi.fn().mockResolvedValue(undefined);
    create = vi.fn(async data => ({ ...data, id: 'p9' }));
    adapters = {
      db: {
        sessions: { delete: sessionsDelete },
        projects: {},
        fabFiles: {},
        agents: {},
        customPages: { create },
      },
    } as unknown as CreateCustomPageAdapters;
  });

  it('opens a page-surface orchestrator session with the page tools, then stores the page', async () => {
    const created = await createPage(user, { name: 'Daily menu', description: 'What to cook' }, adapters);

    expect(mockCreateSession).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        name: 'Daily menu',
        surface: PAGE_SURFACE,
        enabledTools: ['page_get_state', 'page_update_state', 'page_set_widget'],
        disabledTools: ['navigate_view'],
        maxToolCalls: 12,
        systemPromptText: expect.stringContaining('What to cook'),
      }),
      adapters
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', orchestratorSessionId: 's9', state: {}, widgets: [], version: 0 })
    );
    expect(created.id).toBe('p9');
  });

  it('deletes the session again when the page insert fails', async () => {
    create.mockRejectedValue(new Error('insert failed'));
    await expect(createPage(user, { name: 'x' }, adapters)).rejects.toThrow('insert failed');
    expect(sessionsDelete).toHaveBeenCalledWith('s9');
  });
});

describe('patchState', () => {
  it('merges the patch and bumps the version', async () => {
    const { adapters } = fakeRepo([page({ state: { ingredients: ['eggs'], diet: 'any' } })]);
    const result = await patchState(
      { pageId: 'p1', userId: 'u1', patch: { ingredients: ['rice'], diet: null } },
      adapters
    );
    expect(result).toMatchObject({ ok: true, page: { state: { ingredients: ['rice'] }, version: 1 } });
  });

  it('returns not_found for another user', async () => {
    const { adapters } = fakeRepo();
    expect(await patchState({ pageId: 'p1', userId: 'u2', patch: { a: 1 } }, adapters)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('rejects state over the byte cap', async () => {
    const { adapters, repo } = fakeRepo();
    const result = await patchState(
      { pageId: 'p1', userId: 'u1', patch: { big: 'x'.repeat(PAGE_STATE_MAX_BYTES) } },
      adapters
    );
    expect(result).toMatchObject({ ok: false, code: 'state_too_large' });
    expect(repo.replaceStateOwned).not.toHaveBeenCalled();
  });

  it('rejects keys Mongo would treat as operators or paths', async () => {
    const { adapters } = fakeRepo();
    expect(await patchState({ pageId: 'p1', userId: 'u1', patch: { $set: 1 } }, adapters)).toMatchObject({
      code: 'invalid',
    });
    expect(await patchState({ pageId: 'p1', userId: 'u1', patch: { a: { 'b.c': 1 } } }, adapters)).toMatchObject({
      code: 'invalid',
    });
  });

  it('rejects deeply nested patches', async () => {
    const { adapters } = fakeRepo();
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 40; i++) deep = { n: deep };
    expect(await patchState({ pageId: 'p1', userId: 'u1', patch: deep }, adapters)).toMatchObject({ code: 'invalid' });
  });

  it('retries once on a version conflict and then reports it', async () => {
    const { adapters, repo } = fakeRepo();
    repo.replaceStateOwned.mockResolvedValueOnce(null);
    expect(await patchState({ pageId: 'p1', userId: 'u1', patch: { a: 1 } }, adapters)).toMatchObject({ ok: true });
    expect(repo.replaceStateOwned).toHaveBeenCalledTimes(2);

    repo.replaceStateOwned.mockReset().mockResolvedValue(null);
    expect(await patchState({ pageId: 'p1', userId: 'u1', patch: { a: 2 } }, adapters)).toMatchObject({
      ok: false,
      code: 'conflict',
    });
    expect(repo.replaceStateOwned).toHaveBeenCalledTimes(2);
  });
});

describe('setWidget', () => {
  it('validates and upserts a widget', async () => {
    const { adapters } = fakeRepo();
    const result = await setWidget(
      {
        pageId: 'p1',
        userId: 'u1',
        widget: { id: 'shopping-list', type: 'checklist', items: [{ id: 'a', label: 'Milk' }] },
      },
      adapters
    );
    expect(result).toMatchObject({
      ok: true,
      page: { widgets: [{ id: 'shopping-list', items: [{ checked: false }] }] },
    });
  });

  it('returns Zod issues for an invalid widget without touching the repo', async () => {
    const { adapters, repo } = fakeRepo();
    const result = await setWidget({ pageId: 'p1', userId: 'u1', widget: { id: 'BAD', type: 'markdown' } }, adapters);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid');
      expect(result.issues?.length).toBeGreaterThan(0);
    }
    expect(repo.upsertWidgetOwned).not.toHaveBeenCalled();
  });

  it('distinguishes a full page from a missing one', async () => {
    const full = Array.from({ length: PAGE_WIDGETS_MAX }, (_, i) => ({
      id: `w${i}`,
      type: 'markdown' as const,
      markdown: '',
    }));
    const { adapters } = fakeRepo([page({ widgets: full })]);
    const widget = { id: 'extra', type: 'markdown', markdown: '' };
    expect(await setWidget({ pageId: 'p1', userId: 'u1', widget }, adapters)).toMatchObject({
      code: 'too_many_widgets',
    });
    expect(await setWidget({ pageId: 'p1', userId: 'u2', widget }, adapters)).toMatchObject({ code: 'not_found' });
  });
});

describe('removeWidget / toggleChecklistItem', () => {
  const checklist: PageWidget = { id: 'list', type: 'checklist', items: [{ id: 'a', label: 'Milk', checked: false }] };

  it('removes an existing widget and reports a missing one', async () => {
    const { adapters } = fakeRepo([page({ widgets: [checklist] })]);
    expect(await removeWidget({ pageId: 'p1', userId: 'u1', widgetId: 'nope' }, adapters)).toMatchObject({
      code: 'not_found',
    });
    expect(await removeWidget({ pageId: 'p1', userId: 'u1', widgetId: 'list' }, adapters)).toMatchObject({
      ok: true,
      page: { widgets: [] },
    });
  });

  it('toggles a checklist item', async () => {
    const { adapters } = fakeRepo([page({ widgets: [checklist] })]);
    const result = await toggleChecklistItem(
      { pageId: 'p1', userId: 'u1', widgetId: 'list', itemId: 'a', checked: true },
      adapters
    );
    expect(result).toMatchObject({ ok: true, page: { widgets: [{ items: [{ checked: true }] }] } });
    expect(
      await toggleChecklistItem({ pageId: 'p1', userId: 'u1', widgetId: 'list', itemId: 'zz', checked: true }, adapters)
    ).toMatchObject({ code: 'not_found' });
  });
});

describe('buildOrchestratorPrompt', () => {
  it('names the page and the tools', () => {
    const prompt = buildOrchestratorPrompt({ name: 'Daily menu' });
    expect(prompt).toContain('"Daily menu"');
    expect(prompt).toContain('page_update_state');
    expect(prompt).toContain('page_set_widget');
    expect(prompt).not.toContain('described it as');
  });
});
