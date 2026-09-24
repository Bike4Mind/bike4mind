import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { ISessionDocument } from '@bike4mind/common';
import useSessionLayout from '@client/app/hooks/useSessionLayout';
import { applySessionCreated, type ApplySessionCreatedDeps } from '../applySessionCreated';

type SessionPage = { data: ISessionDocument[]; hasMore: boolean };

const OWN_LIST_KEY = ['sessions', 'own', '', ''];
const TMP_ID = 'optimistic-session-mint';

const session = (id: string, extra: Partial<ISessionDocument> = {}) =>
  ({ id, name: `Notebook ${id}`, ...extra }) as ISessionDocument;

const setup = (current: ISessionDocument | null) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData<InfiniteData<SessionPage>>(OWN_LIST_KEY, {
    pages: [{ data: [session('older')], hasMore: false }],
    pageParams: [{ page: 1 }],
  });
  let currentSession = current;
  let pendingRealAtNavigate: string | null | undefined;
  let tmpQuestsAtNavigate: unknown;
  const deps: ApplySessionCreatedDeps = {
    queryClient,
    migrateQuests: vi.fn(),
    migrateSession: vi.fn(),
    cleanupOptimistic: vi.fn(),
    setCurrentSessionId: vi.fn(),
    setCurrentSession: vi.fn(next => {
      currentSession = typeof next === 'function' ? next(currentSession) : next;
    }),
    onSessionCreated: vi.fn(),
    navigateToSession: vi.fn(async () => {
      pendingRealAtNavigate = useSessionLayout.getState().pendingRealSessionId;
      tmpQuestsAtNavigate = (deps.cleanupOptimistic as ReturnType<typeof vi.fn>).mock.calls.length;
    }),
  };
  const listIds = () =>
    queryClient.getQueryData<InfiniteData<SessionPage>>(OWN_LIST_KEY)?.pages.flatMap(p => p.data.map(s => s.id));
  return {
    deps,
    listIds,
    current: () => currentSession,
    pendingRealAtNavigate: () => pendingRealAtNavigate,
    cleanupsBeforeNavigate: () => tmpQuestsAtNavigate,
  };
};

describe('applySessionCreated', () => {
  beforeEach(() => {
    useSessionLayout.setState({ pendingOptimisticId: null, pendingRealSessionId: null });
  });

  it("adds another tab's new notebook to the sidebar list without switching this tab to it", async () => {
    const viewing = session('tab-2-notebook');
    const { deps, listIds, current } = setup(viewing);

    const minted = await applySessionCreated(session('tab-1-new'), deps);

    expect(minted).toBe(false);
    expect(listIds()).toEqual(['tab-1-new', 'older']);
    expect(deps.setCurrentSessionId).not.toHaveBeenCalled();
    expect(deps.navigateToSession).not.toHaveBeenCalled();
    expect(deps.migrateQuests).not.toHaveBeenCalled();
    expect(deps.cleanupOptimistic).not.toHaveBeenCalled();
    expect(deps.onSessionCreated).not.toHaveBeenCalled();
    expect(current()).toBe(viewing);
  });

  it('leaves a tab on /new with no send of its own on /new', async () => {
    const { deps, current } = setup(null);

    await applySessionCreated(session('tab-1-new'), deps);

    expect(deps.setCurrentSessionId).not.toHaveBeenCalled();
    expect(deps.navigateToSession).not.toHaveBeenCalled();
    expect(current()).toBeNull();
  });

  it('merges into an already-adopted copy of the same session instead of replacing it', async () => {
    const adopted = session('lake-session', { knowledgeIds: ['file-1'] });
    const { deps, current } = setup(adopted);

    await applySessionCreated(session('lake-session', { name: 'Wire name' }), deps);

    expect(current()).toMatchObject({ id: 'lake-session', name: 'Wire name', knowledgeIds: ['file-1'] });
    expect(deps.setCurrentSessionId).not.toHaveBeenCalled();
  });

  it('switches the minting tab to its new session and lists it', async () => {
    useSessionLayout.setState({ pendingOptimisticId: TMP_ID });
    const { deps, listIds, current, pendingRealAtNavigate, cleanupsBeforeNavigate } = setup(session(TMP_ID));
    const created = session('real-new');

    const minted = await applySessionCreated(created, deps);

    expect(minted).toBe(true);
    expect(listIds()).toEqual(['real-new', 'older']);
    // The tmp quests stay readable until the URL has left the tmpId, or the view paints empty.
    expect(deps.migrateQuests).toHaveBeenCalledWith(TMP_ID, 'real-new', { keepTmp: true });
    expect(cleanupsBeforeNavigate()).toBe(0);
    expect(deps.cleanupOptimistic).toHaveBeenCalledWith(TMP_ID);
    expect(deps.migrateSession).toHaveBeenCalledWith(TMP_ID, 'real-new', created);
    expect(deps.setCurrentSessionId).toHaveBeenCalledWith('real-new');
    expect(current()).toBe(created);
    expect(deps.navigateToSession).toHaveBeenCalledWith('real-new');
    // Recorded for the stream gate while navigating, cleared with the optimistic id afterwards.
    expect(pendingRealAtNavigate()).toBe('real-new');
    expect(useSessionLayout.getState()).toMatchObject({ pendingOptimisticId: null, pendingRealSessionId: null });
  });
});
