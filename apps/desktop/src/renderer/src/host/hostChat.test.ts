import { describe, expect, it, vi } from 'vitest';
import type { ChatSessionSummary } from '@shared/chat';
import { LOCAL_HOST_ID } from '@shared/hostBridge';
import { HOST_ERROR_CODES, HostRequestError, type HostMethod } from '@shared/hostProtocol';
import type { SidebarSectionsState } from '@shared/sidebarSections';
import type { HostClient } from './HostClient';
import { createHostChat, type LocalDesktop } from './hostChat';

const summary = (id: string, extra: Partial<ChatSessionSummary> = {}) =>
  ({ id, title: id, ...extra }) as ChatSessionSummary;
const question = { parentTitle: 'Parent', finished: [{ id: 'c1', title: 'Done' }], kept: [] };
const sections: SidebarSectionsState = { sections: [], assignments: {} };

function setup(answers: Partial<Record<HostMethod, (params: unknown) => unknown>> = {}) {
  const request = vi.fn(async (_hostId: string, method: HostMethod, params?: unknown) => {
    const answer = answers[method];
    if (!answer) throw new HostRequestError({ code: HOST_ERROR_CODES.methodNotFound, message: method });
    return answer(params);
  });
  const client = { request, onNotification: vi.fn() } as unknown as HostClient;
  const local = {
    confirmArchive: vi.fn<LocalDesktop['confirmArchive']>(async () => ({ confirmed: true, archiveChildIds: ['c1'] })),
    moveToSection: vi.fn<LocalDesktop['moveToSection']>(async () => sections),
  };
  return { chat: createHostChat(client, () => local), request, local };
}

describe('hostChat', () => {
  it('sends every call to the local host and unwraps the protocol result', async () => {
    const { chat, request } = setup({ 'session/get': () => ({ session: null, cursor: { epoch: 'e', seq: 0 } }) });
    expect(await chat.getSession('s1', true)).toBeNull();
    expect(request).toHaveBeenCalledWith(LOCAL_HOST_ID, 'session/get', { sessionId: 's1', viewed: true });
  });

  it('rejects with the host error when the host refuses', async () => {
    const { chat } = setup();
    await expect(chat.stopReply('s1')).rejects.toMatchObject({ code: HOST_ERROR_CODES.methodNotFound });
  });

  describe('setSessionArchived', () => {
    it('archives at once when the host asks nothing', async () => {
      const { chat, request, local } = setup({ 'session/setArchived': () => ({ summary: summary('s1') }) });
      expect(await chat.setSessionArchived('s1', true)).toEqual(summary('s1'));
      expect(request).toHaveBeenCalledTimes(1);
      expect(local.confirmArchive).not.toHaveBeenCalled();
    });

    it('asks the user the host question, then sends their decision', async () => {
      const setArchived = vi.fn((params: unknown) =>
        (params as { confirmed?: boolean }).confirmed
          ? { summary: summary('parent', { archived: true }) }
          : { summary: null, confirmationRequired: question }
      );
      const { chat, request, local } = setup({ 'session/setArchived': setArchived });
      expect(await chat.setSessionArchived('parent', true)).toEqual(summary('parent', { archived: true }));
      expect(local.confirmArchive).toHaveBeenCalledWith(question);
      expect(request).toHaveBeenLastCalledWith(LOCAL_HOST_ID, 'session/setArchived', {
        sessionId: 'parent',
        archived: true,
        confirmed: true,
        archiveChildIds: ['c1'],
      });
    });

    it('changes nothing when the user cancels', async () => {
      const { chat, request, local } = setup({
        'session/setArchived': () => ({ summary: null, confirmationRequired: question }),
      });
      local.confirmArchive.mockResolvedValueOnce(null);
      expect(await chat.setSessionArchived('parent', true)).toBeNull();
      expect(request).toHaveBeenCalledTimes(1);
    });
  });

  it('deletes with discard only when the caller says the user saw what it loses', async () => {
    const { chat, request } = setup({ 'session/delete': () => ({}) });
    await chat.deleteSession('s1', { removeWorktree: true, allowDiscard: true });
    expect(request).toHaveBeenLastCalledWith(LOCAL_HOST_ID, 'session/delete', {
      sessionId: 's1',
      removeWorktree: true,
      allowDiscard: true,
    });
    await chat.deleteSession('s2', { allowDiscard: false });
    expect(request).toHaveBeenLastCalledWith(LOCAL_HOST_ID, 'session/delete', {
      sessionId: 's2',
      removeWorktree: false,
      allowDiscard: false,
    });
  });

  it('deletes a session tree and passes the host report through', async () => {
    const { chat, request } = setup({ 'session/deleteTree': () => ({ deleted: ['c1'], error: 'busy' }) });
    expect(await chat.deleteSessionTree('p', ['c1', 'c2'], true, ['c1'], true)).toEqual({
      deleted: ['c1'],
      error: 'busy',
    });
    expect(request).toHaveBeenCalledWith(LOCAL_HOST_ID, 'session/deleteTree', {
      sessionId: 'p',
      nestedIds: ['c1', 'c2'],
      removeWorktree: true,
      nestedWorktreeIds: ['c1'],
      allowDiscard: true,
    });
  });

  describe('createCodeSession', () => {
    const created = () => ({ ok: true, session: summary('code-1') });

    it('keeps the section out of the host request and files the new session locally', async () => {
      const { chat, request, local } = setup({ 'session/create': created });
      const result = await chat.createCodeSession({ directory: '/work', sectionId: 'sec-1' });
      expect(request).toHaveBeenCalledWith(LOCAL_HOST_ID, 'session/create', { directory: '/work' });
      expect(local.moveToSection).toHaveBeenCalledWith('code-1', 'sec-1');
      expect(result).toEqual({ ok: true, session: summary('code-1'), sidebarSections: sections });
    });

    it('reports a placement that could not be saved, with the session still created', async () => {
      const { chat, local } = setup({ 'session/create': created });
      local.moveToSection.mockRejectedValueOnce(new Error('disk full'));
      expect(await chat.createCodeSession({ directory: '/work', sectionId: 'sec-1' })).toEqual({
        ok: true,
        session: summary('code-1'),
        placementFailed: true,
      });
    });

    it('places nothing for a refused create', async () => {
      const { chat, local } = setup({ 'session/create': () => ({ ok: false, error: 'gone' }) });
      expect(await chat.createCodeSession({ directory: '/gone', sectionId: 'sec-1' })).toEqual({
        ok: false,
        error: 'gone',
      });
      expect(local.moveToSection).not.toHaveBeenCalled();
    });

    it('places nothing when no section was asked for', async () => {
      const { chat, local } = setup({ 'session/create': created });
      expect(await chat.createCodeSession({ directory: '/work' })).toEqual({ ok: true, session: summary('code-1') });
      expect(local.moveToSection).not.toHaveBeenCalled();
    });
  });

  it('routes approvals and task decisions through request/respond by kind', async () => {
    const { chat, request } = setup({ 'request/respond': () => ({}) });
    await chat.respondToApproval('s1', 'a1', { decision: 'once' });
    expect(request).toHaveBeenLastCalledWith(LOCAL_HOST_ID, 'request/respond', {
      kind: 'approval',
      requestId: 'a1',
      answer: { decision: 'once' },
    });
    await chat.answerTaskDecision('s1', 'd1', { status: 'skipped' });
    expect(request).toHaveBeenLastCalledWith(LOCAL_HOST_ID, 'request/respond', {
      kind: 'taskDecision',
      sessionId: 's1',
      decisionId: 'd1',
      answer: { status: 'skipped' },
    });
  });

  it('forgets a recent folder by path and returns the list that is left', async () => {
    const { chat, request } = setup({ 'project/forgetRecent': () => ({ folders: [{ path: '/b', name: 'b' }] }) });
    expect(await chat.removeRecentFolder('/a')).toEqual([{ path: '/b', name: 'b' }]);
    expect(request).toHaveBeenCalledWith(LOCAL_HOST_ID, 'project/forgetRecent', { path: '/a' });
  });
});
