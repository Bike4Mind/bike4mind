import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../chat/SessionStore';
import { sessionScopeKey, type SessionScope } from '../chat/sessionScope';
import { importScopeTag } from './ClaudeCodeSync';
import { ClaudeImportService } from './ClaudeImportService';
import { webSessionId, type WebApi } from './WebSessionSync';

vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => null }, dialog: {} }));

interface FakeNotebook {
  name: string;
  updatedAt: string;
  quests: { id: string; prompt: string; reply?: string; status?: string }[];
}

/** The two list routes the sync reads, paged the way the server pages them. */
function fakeWeb(notebooks: Record<string, FakeNotebook>) {
  const get = vi.fn(async (url: string): Promise<unknown> => {
    const parsed = new URL(url, 'https://web.test');
    const page = Number(parsed.searchParams.get('pagination[page]'));
    const limit = Number(parsed.searchParams.get('pagination[limit]'));
    const slice = <T>(rows: T[]) => ({
      data: rows.slice((page - 1) * limit, page * limit),
      hasMore: rows.length > page * limit,
    });
    const chat = /^\/api\/sessions\/([^/]+)\/chat$/.exec(parsed.pathname);
    if (chat) {
      const notebook = notebooks[decodeURIComponent(chat[1])];
      if (!notebook) throw new Error('Session not found');
      return slice(notebook.quests.map(quest => ({ type: 'message', timestamp: notebook.updatedAt, ...quest })));
    }
    if (parsed.pathname === '/api/sessions') {
      return slice(Object.entries(notebooks).map(([id, notebook]) => ({ id, ...notebook })));
    }
    throw new Error(`unexpected ${url}`);
  });
  return { notebooks, get, api: { get } as unknown as WebApi };
}

const ACCOUNT_A: SessionScope = { environmentUrl: 'https://web.test', accountId: 'account-a' };
const ACCOUNT_B: SessionScope = { environmentUrl: 'https://web.test', accountId: 'account-b' };

let services: ClaudeImportService[] = [];
afterEach(() => {
  for (const service of services) service.dispose();
  services = [];
});

async function setup(apis: Map<string, WebApi>, initial: SessionScope | null = ACCOUNT_A) {
  const root = await mkdtemp(join(tmpdir(), 'web-session-sync-'));
  let scope = initial;
  const store = new SessionStore(join(root, 'sessions'), 'default-model', undefined, () => scope);
  const service = new ClaudeImportService({
    home: join(root, 'home'),
    userData: join(root, 'userData'),
    store,
    scopeKey: () => (scope ? sessionScopeKey(scope) : null),
    pickModel: async () => 'picked-model',
    listSessions: () => store.list(),
    deleteImported: (id, scopeKey) => store.deleteImported(id, scopeKey),
    pickPath: async () => null,
    send: () => {},
    logger: { warn: () => {} },
    webApi: () => (scope ? (apis.get(scope.accountId) ?? null) : null),
  });
  services.push(service);
  return {
    store,
    service,
    signIn: (next: SessionScope | null) => {
      scope = next;
      service.onScopeChanged();
    },
  };
}

const idFor = (scope: SessionScope, notebookId: string) =>
  webSessionId(notebookId, importScopeTag(sessionScopeKey(scope)));

function oneNotebook(): Record<string, FakeNotebook> {
  return {
    nb1: {
      name: 'Trip plan',
      updatedAt: '2026-01-01T00:00:00.000Z',
      quests: [{ id: 'q1', prompt: 'Where to?', reply: 'Lisbon' }],
    },
  };
}

describe('Bike4Mind web sync', () => {
  it('does nothing until enabled, then imports notebooks with a web origin', async () => {
    const web = fakeWeb(oneNotebook());
    const { service, store } = await setup(new Map([['account-a', web.api]]));
    await service.syncWeb();
    expect(web.get).not.toHaveBeenCalled();

    await service.setWebSettings({ enabled: true });
    await service.syncWeb();
    const session = await store.get(idFor(ACCOUNT_A, 'nb1'));
    expect(session?.title).toBe('Trip plan');
    expect(session?.importOrigin).toMatchObject({ kind: 'b4m-web', sourceId: 'nb1' });
    expect(session?.messages.map(message => message.content)).toEqual(['Where to?', 'Lisbon']);
    const state = await service.state();
    expect(state.web.counts).toEqual({ found: 1, imported: 1, skipped: 0, failed: 0 });
    expect(state.web.lastSyncAt).not.toBeNull();
  });

  it('reads only changed notebooks, and appends new quests without duplicates', async () => {
    const web = fakeWeb({
      ...oneNotebook(),
      nb2: { name: 'Other', updatedAt: '2026-01-01T00:00:00.000Z', quests: [{ id: 'q9', prompt: 'x', reply: 'y' }] },
    });
    const { service, store } = await setup(new Map([['account-a', web.api]]));
    await service.setWebSettings({ enabled: true });
    await service.syncWeb();
    web.get.mockClear();

    await service.syncWeb();
    expect(web.get.mock.calls.map(([url]) => new URL(url, 'https://web.test').pathname)).toEqual(['/api/sessions']);

    web.notebooks.nb1.quests.push({ id: 'q2', prompt: 'When?', reply: 'May' });
    web.notebooks.nb1.updatedAt = '2026-01-02T00:00:00.000Z';
    web.get.mockClear();
    await service.syncWeb();
    const chatReads = web.get.mock.calls.map(([url]) => new URL(url, 'https://web.test').pathname);
    expect(chatReads).toEqual(['/api/sessions', '/api/sessions/nb1/chat']);
    const messages = (await store.get(idFor(ACCOUNT_A, 'nb1')))?.messages ?? [];
    expect(messages.map(message => message.id)).toEqual(['bw-q1-p', 'bw-q1-r', 'bw-q2-p', 'bw-q2-r']);
  });

  it('pages through long notebook lists and long notebooks', async () => {
    const notebooks: Record<string, FakeNotebook> = {};
    for (let index = 0; index < 205; index++) {
      notebooks[`nb${index}`] = { name: `Notebook ${index}`, updatedAt: '2026-01-01T00:00:00.000Z', quests: [] };
    }
    notebooks.nb0.quests = Array.from({ length: 150 }, (_, index) => ({ id: `q${index}`, prompt: `p${index}` }));
    const web = fakeWeb(notebooks);
    const { service, store } = await setup(new Map([['account-a', web.api]]));
    await service.setWebSettings({ enabled: true });
    await service.syncWeb();
    expect((await service.state()).web.counts.found).toBe(205);
    expect((await store.get(idFor(ACCOUNT_A, 'nb0')))?.messages).toHaveLength(150);
  });

  it('reads a notebook again while its reply was still running', async () => {
    const web = fakeWeb({
      nb1: {
        name: 'Live',
        updatedAt: '2026-01-01T00:00:00.000Z',
        quests: [{ id: 'q1', prompt: 'Go', status: 'running' }],
      },
    });
    const { service, store } = await setup(new Map([['account-a', web.api]]));
    await service.setWebSettings({ enabled: true });
    await service.syncWeb();
    web.notebooks.nb1.quests[0] = { id: 'q1', prompt: 'Go', reply: 'Done', status: 'done' };
    await service.syncWeb();
    expect((await store.get(idFor(ACCOUNT_A, 'nb1')))?.messages.map(message => message.content)).toEqual([
      'Go',
      'Done',
    ]);
  });

  it('never overwrites a session continued here', async () => {
    const web = fakeWeb(oneNotebook());
    const { service, store } = await setup(new Map([['account-a', web.api]]));
    await service.setWebSettings({ enabled: true });
    await service.syncWeb();
    const id = idFor(ACCOUNT_A, 'nb1');
    await store.appendMessage(id, { id: 'desktop-turn', role: 'user', content: 'mine', createdAt: 'x' });

    web.notebooks.nb1.quests.push({ id: 'q2', prompt: 'later on web', reply: 'r' });
    web.notebooks.nb1.updatedAt = '2026-01-05T00:00:00.000Z';
    await service.syncWeb();
    const session = await store.get(id);
    expect(session?.messages.map(message => message.content)).toEqual(['Where to?', 'Lisbon', 'mine']);
    expect(session?.importOrigin?.forkedAt).toBeTruthy();
    expect((await service.state()).web.forked).toBe(1);
  });

  it('removes an untouched copy when its notebook is deleted on the web', async () => {
    const web = fakeWeb(oneNotebook());
    const { service, store } = await setup(new Map([['account-a', web.api]]));
    await service.setWebSettings({ enabled: true });
    await service.syncWeb();
    delete web.notebooks.nb1;
    await service.syncWeb();
    expect(await store.get(idFor(ACCOUNT_A, 'nb1'))).toBeNull();
    expect((await service.state()).web.counts.found).toBe(0);
  });

  it('drops an untouched copy when every quest is removed on the web', async () => {
    const web = fakeWeb(oneNotebook());
    const { service, store } = await setup(new Map([['account-a', web.api]]));
    await service.setWebSettings({ enabled: true });
    await service.syncWeb();
    web.notebooks.nb1 = { ...web.notebooks.nb1, updatedAt: '2026-01-02T00:00:00.000Z', quests: [] };
    await service.syncWeb();
    expect(await store.get(idFor(ACCOUNT_A, 'nb1'))).toBeNull();

    web.notebooks.nb1 = {
      ...web.notebooks.nb1,
      updatedAt: '2026-01-03T00:00:00.000Z',
      quests: [{ id: 'q2', prompt: 'Again?', reply: 'Yes' }],
    };
    await service.syncWeb();
    expect((await store.get(idFor(ACCOUNT_A, 'nb1')))?.messages).toHaveLength(2);
  });

  it('does nothing while signed out', async () => {
    const web = fakeWeb(oneNotebook());
    const { service, store } = await setup(new Map([['account-a', web.api]]), null);
    await service.setWebSettings({ enabled: true });
    await service.syncWeb();
    expect(web.get).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
    expect((await service.state()).signedIn).toBe(false);
  });

  it("keeps each account's web sessions to that account", async () => {
    const webA = fakeWeb(oneNotebook());
    const webB = fakeWeb({
      nbB: { name: 'B only', updatedAt: '2026-01-01T00:00:00.000Z', quests: [{ id: 'qb', prompt: 'b', reply: 'b' }] },
    });
    const { service, store, signIn } = await setup(
      new Map([
        ['account-a', webA.api],
        ['account-b', webB.api],
      ])
    );
    await service.setWebSettings({ enabled: true });
    await service.syncWeb();
    expect((await store.list()).map(session => session.title)).toEqual(['Trip plan']);

    signIn(ACCOUNT_B);
    expect(await store.list()).toEqual([]);
    await service.syncWeb();
    expect((await store.list()).map(session => session.title)).toEqual(['B only']);
    expect(await store.get(idFor(ACCOUNT_B, 'nb1'))).toBeNull();
    expect(webB.get.mock.calls.some(([url]) => url.includes('nb1'))).toBe(false);
  });

  it('removes untouched web sessions, keeps continued ones, and turns sync off', async () => {
    const web = fakeWeb({
      ...oneNotebook(),
      nb2: { name: 'Keep', updatedAt: '2026-01-01T00:00:00.000Z', quests: [{ id: 'q9', prompt: 'x', reply: 'y' }] },
    });
    const { service, store } = await setup(new Map([['account-a', web.api]]));
    await service.setWebSettings({ enabled: true });
    await service.syncWeb();
    await store.appendMessage(idFor(ACCOUNT_A, 'nb2'), { id: 'mine', role: 'user', content: 'mine', createdAt: 'x' });

    expect(await service.removeImported('b4m-web')).toEqual({ removed: 1, keptForked: 1 });
    expect(await store.get(idFor(ACCOUNT_A, 'nb1'))).toBeNull();
    expect(await store.get(idFor(ACCOUNT_A, 'nb2'))).not.toBeNull();
    const state = await service.state();
    expect(state.web.settings.enabled).toBe(false);
    expect(state.web.counts).toEqual({ found: 1, imported: 1, skipped: 0, failed: 0 });
  });
});
