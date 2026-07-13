import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ISessionDocument } from '@bike4mind/common';
import { useSessionCacheMigration } from '../useSessionCacheMigration';
import { useChatInput } from '@client/app/hooks/useChatInput';

const TMP_ID = 'optimistic-session-123';
const REAL_ID = 'real-session-456';

// Minimal stand-in for the paginated quest cache shape.
function makeQuestsData(ids: string[]) {
  return { pages: [{ data: ids.map(id => ({ id })) }], pageParams: [undefined] };
}

function makeSession(id: string): ISessionDocument {
  // Only `id` is read by the migration; cast keeps the test focused on cache movement.
  return { id, name: `session-${id}` } as unknown as ISessionDocument;
}

describe('useSessionCacheMigration', () => {
  let queryClient: QueryClient;

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  const renderMigration = () => renderHook(() => useSessionCacheMigration(), { wrapper }).result;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    useChatInput.setState({ drafts: {} });
  });

  describe('migrateQuests', () => {
    it('moves the paginated quest list from tmpId to realId, preserving the data', () => {
      const questsData = makeQuestsData(['q1', 'q2']);
      queryClient.setQueryData(['quests', 'session', TMP_ID], questsData);

      const result = renderMigration();
      result.current.migrateQuests(TMP_ID, REAL_ID);

      expect(queryClient.getQueryData(['quests', 'session', REAL_ID])).toEqual(questsData);
      expect(queryClient.getQueryData(['quests', 'session', TMP_ID])).toBeUndefined();
    });

    it('is a no-op when there is no tmp quest cache (no empty entry created under realId)', () => {
      const result = renderMigration();
      result.current.migrateQuests(TMP_ID, REAL_ID);

      expect(queryClient.getQueryData(['quests', 'session', REAL_ID])).toBeUndefined();
      expect(queryClient.getQueryData(['quests', 'session', TMP_ID])).toBeUndefined();
    });
  });

  describe('migrateSession', () => {
    it('writes the real session under realId and removes the synthetic tmp entry', () => {
      queryClient.setQueryData(['sessions', TMP_ID], makeSession(TMP_ID));
      const realSession = makeSession(REAL_ID);

      const result = renderMigration();
      result.current.migrateSession(TMP_ID, REAL_ID, realSession);

      expect(queryClient.getQueryData(['sessions', REAL_ID])).toEqual(realSession);
      expect(queryClient.getQueryData(['sessions', TMP_ID])).toBeUndefined();
    });

    it('overwrites an existing realId entry with the freshly provided server data', () => {
      queryClient.setQueryData(['sessions', REAL_ID], makeSession('stale'));
      const realSession = makeSession(REAL_ID);

      const result = renderMigration();
      result.current.migrateSession(TMP_ID, REAL_ID, realSession);

      expect(queryClient.getQueryData(['sessions', REAL_ID])).toEqual(realSession);
    });

    it('clears the leftover empty tmpId draft left behind by the composer', () => {
      useChatInput.getState().setDraft(TMP_ID, '');
      expect(useChatInput.getState().drafts).toHaveProperty(TMP_ID);

      const result = renderMigration();
      result.current.migrateSession(TMP_ID, REAL_ID, makeSession(REAL_ID));

      expect(useChatInput.getState().drafts).not.toHaveProperty(TMP_ID);
    });

    it('leaves an unrelated real-session draft untouched', () => {
      useChatInput.getState().setDraft(REAL_ID, 'work in progress');

      const result = renderMigration();
      result.current.migrateSession(TMP_ID, REAL_ID, makeSession(REAL_ID));

      expect(useChatInput.getState().getDraft(REAL_ID)).toBe('work in progress');
    });
  });

  describe('cleanupOptimistic', () => {
    it('removes both the synthetic session and optimistic quest cache entries', () => {
      queryClient.setQueryData(['sessions', TMP_ID], makeSession(TMP_ID));
      queryClient.setQueryData(['quests', 'session', TMP_ID], makeQuestsData(['q1']));

      const result = renderMigration();
      result.current.cleanupOptimistic(TMP_ID);

      expect(queryClient.getQueryData(['sessions', TMP_ID])).toBeUndefined();
      expect(queryClient.getQueryData(['quests', 'session', TMP_ID])).toBeUndefined();
    });
  });

  describe('idempotency', () => {
    it('a second migration call after the keys are gone is a harmless no-op', () => {
      queryClient.setQueryData(['quests', 'session', TMP_ID], makeQuestsData(['q1']));
      queryClient.setQueryData(['sessions', TMP_ID], makeSession(TMP_ID));
      const realSession = makeSession(REAL_ID);

      const result = renderMigration();
      result.current.migrateQuests(TMP_ID, REAL_ID);
      result.current.migrateSession(TMP_ID, REAL_ID, realSession);

      // Second pass (e.g. the fallback path firing after session.created already ran).
      result.current.migrateQuests(TMP_ID, REAL_ID);
      result.current.migrateSession(TMP_ID, REAL_ID, realSession);

      expect(queryClient.getQueryData(['quests', 'session', REAL_ID])).toEqual(makeQuestsData(['q1']));
      expect(queryClient.getQueryData(['sessions', REAL_ID])).toEqual(realSession);
      expect(queryClient.getQueryData(['quests', 'session', TMP_ID])).toBeUndefined();
      expect(queryClient.getQueryData(['sessions', TMP_ID])).toBeUndefined();
    });
  });
});
