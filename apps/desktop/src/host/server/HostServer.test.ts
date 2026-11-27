import { describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatSessionStatusEvent, ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import {
  HOST_ERROR_CODES,
  hostErrorData,
  hostMethods,
  hostRequest,
  type HostMethod,
  type HostNotification,
  type HostResponse,
  type HostResult,
} from '@shared/hostProtocol';
import { SessionEventLog } from '../../main/chat/SessionEventLog';
import { HostEventRelay } from './HostEventRelay';
import { HostServer, pendingHostMethods, type HostServerRuntime } from './HostServer';

const summary = (id: string): ChatSessionSummary => ({ id, title: id }) as ChatSessionSummary;
const status = (sessionId: string): ChatSessionStatusEvent => ({ sessionId, status: 'processing' });
const token = (sessionId: string, text: string): ChatStreamEvent => ({
  type: 'delta',
  sessionId,
  messageId: 'm1',
  text,
});

function fakeRuntime(eventLog = new SessionEventLog({ epoch: 'epoch-1' })) {
  const runtime = {
    listSessions: vi.fn(async () => [summary('s1'), summary('s2')]),
    listSessionPage: vi.fn(async () => ({ sessions: [summary('s1')], related: [], nextCursor: 'c1', total: 2 })),
    getSession: vi.fn(async (sessionId: string) =>
      sessionId === 'missing'
        ? null
        : ({
            id: sessionId,
            messages: [{ id: 'm1', role: 'assistant', rounds: [{ text: 'hi', sent: { prompt: 'secret' } }] }],
            eventCursor: eventLog.cursor(sessionId),
          } as unknown as ChatSession & { eventCursor: ReturnType<SessionEventLog['cursor']> })
    ),
    renameSession: vi.fn(async (sessionId: string, title: string) => ({ ...summary(sessionId), title })),
    deleteSession: vi.fn(async () => undefined),
    createSession: vi.fn(async () => summary('chat-1')),
    createCodeSession: vi.fn(async (request: { directory?: string }) =>
      request.directory === '/gone'
        ? { ok: false as const, error: 'That folder no longer exists' }
        : { ok: true as const, session: summary('code-1') }
    ),
    setSessionArchived: vi.fn(
      async (
        sessionId: string,
        archived: boolean,
        decision?: { confirmed?: boolean; archiveChildIds?: readonly string[] }
      ): Promise<HostResult<'session/setArchived'>> =>
        sessionId === 'parent' && archived && !decision?.confirmed
          ? { summary: null, confirmationRequired: { parentTitle: 'Parent', finished: [], kept: [] } }
          : { summary: { ...summary(sessionId), archived } }
    ),
    deleteSessionTree: vi.fn(async (sessionId: string, nestedIds: readonly string[]) => ({
      deleted: [...nestedIds, sessionId],
      error: null as string | null,
    })),
    respondToApproval: vi.fn(),
    answerTaskDecision: vi.fn(async () => undefined),
    stopBackgroundProcess: vi.fn(async (sessionId: string, processId: string) =>
      processId === 'p1'
        ? { ok: true as const, process: { id: 'p1', sessionId, status: 'killed' } }
        : { ok: false as const, reason: 'notFound' as const }
    ),
    browseDirectory: vi.fn(async (path?: string) =>
      path === '/gone'
        ? { ok: false as const, reason: 'notFound' as const, path: '/gone' }
        : {
            ok: true as const,
            listing: {
              path: '/home/dev',
              parent: '/home',
              entries: [{ name: 'repo', path: '/home/dev/repo', isGitRepository: true }],
              truncated: false,
            },
          }
    ),
    listRecentFolders: vi.fn(async () => [{ path: '/work', name: 'work' }]),
    sendMessage: vi.fn(async () => ({ ok: true as const })),
    stopReply: vi.fn(),
    sessionStatuses: vi.fn(() => [status('s1')]),
    draftDefaults: vi.fn(async () => ({ model: 'model-a', approvalMode: 'ask' })),
    listModels: vi.fn(async () => ({ models: [] })),
    queuedMessages: vi.fn(async (sessionId: string) => [{ id: 'q1', sessionId }]),
    cancelQueued: vi.fn(),
    sendQueuedNow: vi.fn(),
    forgetRecentFolder: vi.fn(async () => []),
    inspectProject: vi.fn(async (directory: string) => ({ directory, isRepository: false, branches: [] })),
    contextNotices: vi.fn((sessionId: string) =>
      sessionId === 's1' ? [{ kind: 'run-budget' as const, message: 'At 80%' }] : []
    ),
    listTaskDecisions: vi.fn(async () => [
      { sessionId: 's1', rootId: 'r1', title: 'Fix it', decision: { kind: 'stopped' as const } },
    ]),
    service: {
      eventsSince: (sessionId: string, after: { epoch: string; seq: number }) => eventLog.since(sessionId, after),
    },
    eventLog,
  };
  return runtime as typeof runtime & HostServerRuntime;
}

function serve(runtime = fakeRuntime()) {
  const warn = vi.fn();
  const relay = new HostEventRelay(error => {
    throw error;
  });
  const server = new HostServer(runtime, relay, { warn });
  const sink = relay.tee({
    streamEvent: () => undefined,
    sessionSummary: () => undefined,
    sessionStatus: () => undefined,
    queueChanged: () => undefined,
    taskDecisions: () => undefined,
    loopChanged: () => undefined,
  });
  const client = () => {
    const received: HostNotification[] = [];
    const connection = server.connect(message => received.push(message));
    let id = 0;
    const call = (method: string, params?: unknown): Promise<HostResponse> =>
      connection.handle(hostRequest(++id, method, params));
    return { received, call, connection };
  };
  return { runtime, server, sink, client, warn };
}

const resultOf = (response: HostResponse): unknown => {
  if (!('result' in response)) throw new Error(`Expected a result, got ${JSON.stringify(response.error)}`);
  return response.result;
};
const errorOf = (response: HostResponse) => {
  if (!('error' in response)) throw new Error('Expected an error');
  return response.error;
};

describe('HostServer', () => {
  it('serves every protocol method, leaving none pending', () => {
    expect(pendingHostMethods).toEqual([]);
  });

  it('answers an unknown method with method not found', async () => {
    const response = await serve().client().call('session/explode');
    expect(response).toMatchObject({ id: 1, error: { code: HOST_ERROR_CODES.methodNotFound } });
  });

  const invalidParams: Array<[Exclude<HostMethod, (typeof pendingHostMethods)[number]>, unknown]> = [
    ['session/get', { sessionId: 7 }],
    ['session/rename', { sessionId: 's1' }],
    ['session/delete', {}],
    ['session/delete', { sessionId: 's1', allowDiscard: 'yes' }],
    ['session/deleteTree', { sessionId: 's1', nestedIds: 'c1' }],
    ['session/create', 'nope'],
    ['session/setArchived', { sessionId: 's1' }],
    ['request/respond', { kind: 'approval', requestId: 'r1' }],
    ['request/respond', { kind: 'taskDecision', requestId: 'r1', answer: { decision: 'once' } }],
    ['background/stop', { sessionId: 's1' }],
    ['fs/browse', { path: 3 }],
    ['project/recent', 'all'],
    ['session/subscribe', { sessionId: 's1', after: { epoch: '', seq: 0 } }],
    ['session/unsubscribe', {}],
    ['turn/send', { sessionId: 's1' }],
    ['turn/stop', null],
    ['queue/list', {}],
    ['queue/cancel', { sessionId: 's1' }],
    ['queue/sendNow', { queuedId: 'q1' }],
    ['model/list', { force: 'remote' }],
    ['session/list', 'all'],
    ['session/page', { limit: 'ten' }],
    ['session/statuses', 3],
    ['draft/defaults', []],
    ['taskDecision/list', 'all'],
    ['project/forgetRecent', {}],
    ['project/inspect', { directory: 3 }],
    ['host/initialize', { clientId: 'c1' }],
    ['host/info', 'now'],
    ['host/auth/start', 3],
    ['host/auth/status', []],
  ];
  it.each(invalidParams)('rejects invalid params for %s without calling the runtime', async (method, params) => {
    const { client, runtime } = serve();
    const response = await client().call(method, params);
    expect(errorOf(response).code).toBe(HOST_ERROR_CODES.invalidParams);
    for (const fn of Object.values(runtime)) if (vi.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled();
  });

  it('covers every method in either the served table or the pending list', () => {
    expect(new Set([...invalidParams.map(([method]) => method), ...pendingHostMethods])).toEqual(
      new Set(Object.keys(hostMethods))
    );
  });

  it('serves session/list and session/statuses in the protocol shapes', async () => {
    const { client } = serve();
    const { call } = client();
    expect(resultOf(await call('session/list'))).toEqual({ sessions: [summary('s1'), summary('s2')] });
    expect(resultOf(await call('session/statuses', {}))).toEqual({ statuses: [status('s1')] });
  });

  it('serves session/page from the runtime with the validated request', async () => {
    const { client, runtime } = serve();
    const { call } = client();
    expect(resultOf(await call('session/page', { limit: 1, cursor: null }))).toEqual({
      sessions: [summary('s1')],
      related: [],
      nextCursor: 'c1',
      total: 2,
    });
    expect(runtime.listSessionPage).toHaveBeenCalledWith({ limit: 1, cursor: null });
  });

  it('serves the project methods from the runtime in the protocol shapes', async () => {
    const { client, runtime } = serve();
    const { call } = client();
    expect(resultOf(await call('project/forgetRecent', { path: '/work' }))).toEqual({ folders: [] });
    expect(runtime.forgetRecentFolder).toHaveBeenCalledWith('/work');
    expect(resultOf(await call('project/inspect', { directory: '/work' }))).toEqual({
      inspection: { directory: '/work', isRepository: false, branches: [] },
    });
  });

  it('serves session/get without the persisted sent field and with its cursor', async () => {
    const { client, runtime } = serve();
    const result = resultOf(await client().call('session/get', { sessionId: 's1', viewed: true }));
    expect(runtime.getSession).toHaveBeenCalledWith('s1', true);
    expect(result).toMatchObject({ cursor: { epoch: 'epoch-1', seq: 0 } });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('serves session/get with the held context notices in force, and none when there are none', async () => {
    const { client } = serve();
    const { call } = client();
    expect(resultOf(await call('session/get', { sessionId: 's1' }))).toMatchObject({
      notices: [{ kind: 'run-budget', message: 'At 80%' }],
    });
    expect(resultOf(await call('session/get', { sessionId: 's2' }))).not.toHaveProperty('notices');
  });

  it('answers session/get for a missing session with a null session and the log cursor', async () => {
    const result = resultOf(await serve().client().call('session/get', { sessionId: 'missing' }));
    expect(result).toEqual({ session: null, cursor: { epoch: 'epoch-1', seq: 0 } });
  });

  it('maps the remaining served methods onto the runtime', async () => {
    const { client, runtime } = serve();
    const { call } = client();
    expect(resultOf(await call('session/rename', { sessionId: 's1', title: 'New' }))).toEqual({
      summary: { id: 's1', title: 'New' },
    });
    expect(resultOf(await call('session/delete', { sessionId: 's1' }))).toEqual({});
    expect(runtime.deleteSession).toHaveBeenCalledWith('s1', false, false);
    expect(resultOf(await call('turn/send', { sessionId: 's1', text: 'hi' }))).toEqual({ ok: true });
    expect(resultOf(await call('turn/stop', { sessionId: 's1' }))).toEqual({});
    expect(runtime.stopReply).toHaveBeenCalledWith('s1');
    expect(resultOf(await call('queue/list', { sessionId: 's1' }))).toEqual({
      queued: [{ id: 'q1', sessionId: 's1' }],
    });
    expect(resultOf(await call('queue/cancel', { sessionId: 's1', queuedId: 'q1' }))).toEqual({});
    expect(runtime.cancelQueued).toHaveBeenCalledWith('s1', 'q1');
    expect(resultOf(await call('queue/sendNow', { sessionId: 's1', queuedId: 'q1' }))).toEqual({});
    expect(runtime.sendQueuedNow).toHaveBeenCalledWith('s1', 'q1');
    expect(resultOf(await call('model/list', {}))).toEqual({ models: { models: [] } });
    expect(runtime.listModels).toHaveBeenCalledWith(false);
    expect(resultOf(await call('draft/defaults'))).toEqual({ defaults: { model: 'model-a', approvalMode: 'ask' } });
    expect(resultOf(await call('taskDecision/list'))).toEqual({
      decisions: [{ sessionId: 's1', rootId: 'r1', title: 'Fix it', decision: { kind: 'stopped' } }],
    });
  });

  describe('session lifecycle', () => {
    it('starts a plain chat session when session/create has no params', async () => {
      const { client, runtime } = serve();
      expect(resultOf(await client().call('session/create'))).toEqual({ ok: true, session: summary('chat-1') });
      expect(runtime.createSession).toHaveBeenCalledWith();
      expect(runtime.createCodeSession).not.toHaveBeenCalled();
    });

    it('starts a Code session from session/create params and passes a refusal through as a result', async () => {
      const { client, runtime } = serve();
      const { call } = client();
      expect(resultOf(await call('session/create', { directory: '/work', branch: 'main' }))).toEqual({
        ok: true,
        session: summary('code-1'),
      });
      expect(runtime.createCodeSession).toHaveBeenCalledWith({ directory: '/work', branch: 'main' });
      expect(resultOf(await call('session/create', { directory: '/gone' }))).toEqual({
        ok: false,
        error: 'That folder no longer exists',
      });
    });

    it('answers session/setArchived with the question first, then archives once confirmed', async () => {
      const { client, runtime } = serve();
      const { call } = client();
      expect(resultOf(await call('session/setArchived', { sessionId: 'parent', archived: true }))).toEqual({
        summary: null,
        confirmationRequired: { parentTitle: 'Parent', finished: [], kept: [] },
      });
      const confirmed = { sessionId: 'parent', archived: true, confirmed: true, archiveChildIds: ['c1'] };
      expect(resultOf(await call('session/setArchived', confirmed))).toEqual({
        summary: { id: 'parent', title: 'parent', archived: true },
      });
      expect(runtime.setSessionArchived).toHaveBeenLastCalledWith('parent', true, {
        confirmed: true,
        archiveChildIds: ['c1'],
      });
    });

    it('deletes with discard only when the client asks for it', async () => {
      const { client, runtime } = serve();
      const { call } = client();
      await call('session/delete', { sessionId: 's1', removeWorktree: true });
      expect(runtime.deleteSession).toHaveBeenLastCalledWith('s1', true, false);
      await call('session/delete', { sessionId: 's1', removeWorktree: true, allowDiscard: true });
      expect(runtime.deleteSession).toHaveBeenLastCalledWith('s1', true, true);
    });

    it('deletes a session tree and reports what went', async () => {
      const { client, runtime } = serve();
      const result = await client().call('session/deleteTree', { sessionId: 'p', nestedIds: ['c1', 'c2'] });
      expect(resultOf(result)).toEqual({ deleted: ['c1', 'c2', 'p'], error: null });
      expect(runtime.deleteSessionTree).toHaveBeenCalledWith('p', ['c1', 'c2'], false, [], false);
    });

    it('passes the discard opt-in and worktree removal through to the runtime', async () => {
      const { client, runtime } = serve();
      await client().call('session/deleteTree', {
        sessionId: 'p',
        nestedIds: ['c1'],
        removeWorktree: true,
        nestedWorktreeIds: ['c1'],
        allowDiscard: true,
      });
      expect(runtime.deleteSessionTree).toHaveBeenCalledWith('p', ['c1'], true, ['c1'], true);
    });

    it('relays a partial failure with what was deleted before it', async () => {
      const { client, runtime } = serve();
      runtime.deleteSessionTree.mockResolvedValueOnce({ deleted: ['c1'], error: 'c2 is busy' });
      const result = await client().call('session/deleteTree', { sessionId: 'p', nestedIds: ['c1', 'c2'] });
      expect(resultOf(result)).toEqual({ deleted: ['c1'], error: 'c2 is busy' });
    });
  });

  const workerId = '0f8fad5b-d9cb-469f-a165-70867728950e';
  it('routes request/respond to the approval or the task decision by kind', async () => {
    const { client, runtime } = serve();
    const { call } = client();
    expect(
      resultOf(await call('request/respond', { kind: 'approval', requestId: 'r1', answer: { decision: 'once' } }))
    ).toEqual({});
    expect(runtime.respondToApproval).toHaveBeenCalledWith('r1', { decision: 'once' });
    const decision = { kind: 'taskDecision', sessionId: workerId, decisionId: 'd1', answer: { status: 'skipped' } };
    expect(resultOf(await call('request/respond', decision))).toEqual({});
    expect(runtime.answerTaskDecision).toHaveBeenCalledWith(workerId, 'd1', { status: 'skipped' });
    expect(runtime.respondToApproval).toHaveBeenCalledTimes(1);
  });

  const tooMany = { selected: ['a', 'b', 'c', 'd', 'e'] };
  it.each([
    ['a session id that is not one', { sessionId: 's1' }],
    ['an empty decision id', { decisionId: '' }],
    ['an over-long decision id', { decisionId: 'd'.repeat(101) }],
    ['an answer with extra keys', { answer: { status: 'skipped', note: 'x' } }],
    ['an answer over its bounds', { answer: { status: 'answered', answers: [tooMany] } }],
  ])('refuses a task decision answer with %s, before the runtime sees it', async (_case, change) => {
    const { client, runtime } = serve();
    const decision = { kind: 'taskDecision', sessionId: workerId, decisionId: 'd1', answer: { status: 'skipped' } };
    const error = errorOf(await client().call('request/respond', { ...decision, ...change }));
    expect(error.code).toBe(HOST_ERROR_CODES.invalidParams);
    expect(runtime.answerTaskDecision).not.toHaveBeenCalled();
  });

  it('stops a background process, and answers an unknown one with processNotFound', async () => {
    const { client, warn } = serve();
    const { call } = client();
    expect(resultOf(await call('background/stop', { sessionId: 's1', processId: 'p1' }))).toEqual({
      process: { id: 'p1', sessionId: 's1', status: 'killed' },
    });
    const error = errorOf(await call('background/stop', { sessionId: 's1', processId: 'p9' }));
    expect(error).toMatchObject({
      code: HOST_ERROR_CODES.processNotFound,
      data: { sessionId: 's1', processId: 'p9' },
    });
    expect(hostErrorData.processNotFound.safeParse(error.data).success).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('browses a directory, and answers one it cannot read with pathUnavailable', async () => {
    const { client, runtime } = serve();
    const { call } = client();
    expect(resultOf(await call('fs/browse'))).toMatchObject({ path: '/home/dev', truncated: false });
    expect(runtime.browseDirectory).toHaveBeenCalledWith(undefined);
    const error = errorOf(await call('fs/browse', { path: '/gone' }));
    expect(error).toMatchObject({
      code: HOST_ERROR_CODES.pathUnavailable,
      data: { path: '/gone', reason: 'notFound' },
    });
    expect(hostErrorData.pathUnavailable.safeParse(error.data).success).toBe(true);
  });

  it('serves project/recent from the runtime', async () => {
    const { client } = serve();
    expect(resultOf(await client().call('project/recent'))).toEqual({ folders: [{ path: '/work', name: 'work' }] });
  });

  it('answers a runtime failure with an internal error and logs it', async () => {
    const { client, runtime, warn } = serve();
    runtime.listSessions.mockRejectedValueOnce(new Error('disk gone'));
    const error = errorOf(await client().call('session/list'));
    expect(error).toEqual({ code: HOST_ERROR_CODES.internalError, message: 'disk gone' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk gone'));
  });

  it('answers a result the protocol does not allow with an internal error', async () => {
    const { client, runtime } = serve();
    runtime.sessionStatuses.mockReturnValueOnce([{ sessionId: 's1' } as ChatSessionStatusEvent]);
    expect(errorOf(await client().call('session/statuses')).code).toBe(HOST_ERROR_CODES.internalError);
  });

  describe('subscriptions', () => {
    it('sends a session event only to the connections subscribed to it', async () => {
      const { client, sink, runtime } = serve();
      const subscribed = client();
      const other = client();
      await subscribed.call('session/subscribe', { sessionId: 's1' });
      await other.call('session/subscribe', { sessionId: 's2' });

      sink.streamEvent(runtime.eventLog.append(token('s1', 'a')));

      expect(subscribed.received).toEqual([
        {
          jsonrpc: '2.0',
          method: 'session/event',
          params: {
            sessionId: 's1',
            seq: 1,
            epoch: 'epoch-1',
            event: expect.objectContaining({ text: 'a', seq: 1 }),
          },
        },
      ]);
      expect(other.received).toEqual([]);
    });

    it('stops sending after unsubscribe and after close', async () => {
      const { client, sink, runtime } = serve();
      const first = client();
      const second = client();
      await first.call('session/subscribe', { sessionId: 's1' });
      await second.call('session/subscribe', { sessionId: 's1' });
      await first.call('session/unsubscribe', { sessionId: 's1' });
      second.connection.close();

      sink.streamEvent(runtime.eventLog.append(token('s1', 'a')));

      expect(first.received).toEqual([]);
      expect(second.received).toEqual([]);
    });

    it('replays the events after the cursor, then streams live', async () => {
      const { client, sink, runtime } = serve();
      const log = runtime.eventLog;
      sink.streamEvent(log.append(token('s1', 'a')));
      sink.streamEvent(log.append(token('s1', 'b')));
      sink.streamEvent(log.append(token('s1', 'c')));
      const { call, received } = client();

      const result = resultOf(
        await call('session/subscribe', { sessionId: 's1', after: { epoch: 'epoch-1', seq: 1 } })
      );
      sink.streamEvent(log.append(token('s1', 'd')));

      expect(result).toEqual({ cursor: { epoch: 'epoch-1', seq: 3 } });
      expect(received.map(message => message.params)).toEqual([
        expect.objectContaining({ seq: 2 }),
        expect.objectContaining({ seq: 3 }),
        expect.objectContaining({ seq: 4 }),
      ]);
    });

    it('returns the current cursor and replays nothing for a subscribe with no cursor', async () => {
      const { client, sink, runtime } = serve();
      sink.streamEvent(runtime.eventLog.append(token('s1', 'a')));
      const { call, received } = client();
      expect(resultOf(await call('session/subscribe', { sessionId: 's1' }))).toEqual({
        cursor: { epoch: 'epoch-1', seq: 1 },
      });
      expect(received).toEqual([]);
    });

    it('requires a snapshot for a cursor from another epoch and does not subscribe', async () => {
      const { client, sink, runtime } = serve();
      const { call, received } = client();
      const response = await call('session/subscribe', { sessionId: 's1', after: { epoch: 'before-restart', seq: 0 } });
      expect(errorOf(response)).toMatchObject({ code: HOST_ERROR_CODES.snapshotRequired, data: { sessionId: 's1' } });

      sink.streamEvent(runtime.eventLog.append(token('s1', 'a')));
      expect(received).toEqual([]);
    });

    it('requires a snapshot when the events after the cursor are no longer held', async () => {
      const log = new SessionEventLog({ epoch: 'epoch-1', maxEvents: 2 });
      const { client, sink } = serve(fakeRuntime(log));
      for (const text of ['a', 'b', 'c', 'd']) sink.streamEvent(log.append(token('s1', text)));

      const response = await client().call('session/subscribe', {
        sessionId: 's1',
        after: { epoch: 'epoch-1', seq: 1 },
      });

      expect(errorOf(response).code).toBe(HOST_ERROR_CODES.snapshotRequired);
    });
  });

  it('sends the list-level changes to every connection, subscribed or not', () => {
    const { client, sink } = serve();
    const first = client();
    const second = client();

    sink.sessionSummary(summary('s1'));
    sink.sessionStatus(status('s2'), false);
    sink.queueChanged({ sessionId: 's1', queued: [] });
    sink.taskDecisions([]);

    const expected = [
      { jsonrpc: '2.0', method: 'session/summaryChanged', params: { summary: summary('s1') } },
      { jsonrpc: '2.0', method: 'session/statusChanged', params: { event: status('s2') } },
      { jsonrpc: '2.0', method: 'session/queueChanged', params: { event: { sessionId: 's1', queued: [] } } },
      { jsonrpc: '2.0', method: 'session/taskDecisionsChanged', params: { decisions: [] } },
    ];
    expect(first.received).toEqual(expected);
    expect(second.received).toEqual(expected);
  });

  it('announces a failed spawn to every connection, besides the event to the subscribers', async () => {
    const { client, sink, runtime } = serve();
    const subscribed = client();
    const other = client();
    await subscribed.call('session/subscribe', { sessionId: 'c1' });

    sink.streamEvent(
      runtime.eventLog.append({ type: 'spawn-failed', sessionId: 'c1', title: 'Fix it', message: 'No model' })
    );

    const announced = {
      jsonrpc: '2.0',
      method: 'session/spawnFailed',
      params: { sessionId: 'c1', title: 'Fix it', message: 'No model' },
    };
    expect(other.received).toEqual([announced]);
    expect(subscribed.received.map(message => message.method)).toEqual(['session/event', 'session/spawnFailed']);
  });

  it('broadcasts a context notice and its withdrawal to every connection', () => {
    const { client, sink, runtime } = serve();
    const first = client();

    sink.streamEvent(
      runtime.eventLog.append({ type: 'context-notice', sessionId: 's2', message: 'At 80%', kind: 'run-budget' })
    );
    sink.streamEvent(runtime.eventLog.append({ type: 'context-notice-cleared', sessionId: 's2', kind: 'run-budget' }));

    expect(first.received).toEqual([
      {
        jsonrpc: '2.0',
        method: 'session/contextNotice',
        params: { event: { type: 'context-notice', sessionId: 's2', message: 'At 80%', kind: 'run-budget' } },
      },
      {
        jsonrpc: '2.0',
        method: 'session/contextNotice',
        params: { event: { type: 'context-notice-cleared', sessionId: 's2', kind: 'run-budget' } },
      },
    ]);
  });

  it('stops watching the runtime once disposed', () => {
    const { client, sink, server } = serve();
    const { received } = client();
    server.dispose();
    sink.sessionSummary(summary('s1'));
    expect(received).toEqual([]);
  });
});
