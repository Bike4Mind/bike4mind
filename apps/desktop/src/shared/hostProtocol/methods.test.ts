import { describe, expect, it } from 'vitest';
import { hostErrorData, hostMethods, hostNotifications, type HostMethod, type HostNotificationName } from './methods';

const cursor = { epoch: 'e1', seq: 4 };
const summary = { id: 's1' };
const account = { userId: 'u1', environmentUrl: 'https://example.test' };
const protocol = { major: 1, minor: 0 };
const info = {
  hostId: 'h1',
  hostName: 'box',
  hostVersion: '1.0.0',
  protocol,
  capabilities: ['queue', 'someFutureThing'],
  platform: 'linux',
  homeDirectory: '/home/dev',
  account,
};
const queued = { id: 'q1', sessionId: 's1', text: 'hi' };
const sessionStatus = { sessionId: 's1', status: 'processing' };

const methodSamples: Record<HostMethod, { params: unknown; badParams: unknown; result: unknown }> = {
  'host/initialize': {
    params: { clientId: 'c1', clientName: 'Desktop', clientVersion: '1.0.0', protocol },
    badParams: { clientId: 'c1' },
    result: info,
  },
  'host/info': { params: {}, badParams: 'nope', result: info },
  'host/auth/start': {
    params: {},
    badParams: 'nope',
    result: { verificationUrl: 'https://x.test', userCode: 'AB-12', expiresAt: 1 },
  },
  'host/auth/status': { params: {}, badParams: 'nope', result: { account: null } },
  'session/list': { params: {}, badParams: 'nope', result: { sessions: [summary] } },
  'session/page': {
    params: { limit: 100, cursor: null, include: ['s1'] },
    badParams: { limit: -1 },
    result: { sessions: [summary], related: [], nextCursor: null, total: 1 },
  },
  'session/get': {
    params: { sessionId: 's1', viewed: true },
    badParams: { viewed: true },
    result: { session: null, cursor },
  },
  'session/create': { params: { directory: '/work' }, badParams: 'nope', result: { ok: true, session: summary } },
  'session/rename': {
    params: { sessionId: 's1', title: 'T' },
    badParams: { sessionId: 's1' },
    result: { summary: null },
  },
  'session/setArchived': {
    params: { sessionId: 's1', archived: true, confirmed: true, archiveChildIds: ['c1'] },
    badParams: { sessionId: 's1', archived: true, archiveChildIds: 'c1' },
    result: { summary },
  },
  'session/delete': {
    params: { sessionId: 's1', removeWorktree: true, allowDiscard: true },
    badParams: { sessionId: 's1', allowDiscard: 'yes' },
    result: {},
  },
  'session/deleteTree': {
    params: { sessionId: 's1', nestedIds: ['c1'], removeWorktree: true, nestedWorktreeIds: ['c1'] },
    badParams: { sessionId: 's1', nestedIds: 'c1' },
    result: { deleted: ['c1'], error: 'checkout busy' },
  },
  'session/subscribe': {
    params: { sessionId: 's1', after: cursor },
    badParams: { sessionId: 's1', after: { epoch: '' } },
    result: { cursor },
  },
  'session/unsubscribe': { params: { sessionId: 's1' }, badParams: {}, result: {} },
  'session/statuses': { params: {}, badParams: 'nope', result: { statuses: [sessionStatus] } },
  'turn/send': {
    params: { sessionId: 's1', text: 'hi' },
    badParams: { sessionId: 's1' },
    result: { ok: true, queued: false, messageId: 'm1' },
  },
  'turn/stop': { params: { sessionId: 's1' }, badParams: {}, result: {} },
  'request/respond': {
    params: { kind: 'approval', requestId: 'r1', answer: { decision: 'once' } },
    badParams: { kind: 'approval', requestId: 'r1' },
    result: {},
  },
  'queue/list': { params: { sessionId: 's1' }, badParams: {}, result: { queued: [queued] } },
  'queue/cancel': { params: { sessionId: 's1', queuedId: 'q1' }, badParams: { sessionId: 's1' }, result: {} },
  'queue/sendNow': { params: { sessionId: 's1', queuedId: 'q1' }, badParams: { queuedId: 'q1' }, result: {} },
  'background/stop': {
    params: { sessionId: 's1', processId: 'p1' },
    badParams: { sessionId: 's1' },
    result: { process: { id: 'p1', sessionId: 's1', status: 'killed' } },
  },
  'fs/browse': {
    params: { path: '/home/dev' },
    badParams: { path: 3 },
    result: {
      path: '/home/dev',
      parent: '/home',
      entries: [{ name: 'repo', path: '/home/dev/repo', isGitRepository: true, isHidden: false, isSymlink: false }],
      truncated: false,
    },
  },
  'project/recent': { params: {}, badParams: 'nope', result: { folders: [{ path: '/work', name: 'work' }] } },
  'project/forgetRecent': { params: { path: '/work' }, badParams: {}, result: { folders: [] } },
  'project/inspect': {
    params: { directory: '/work' },
    badParams: { directory: 1 },
    result: { inspection: { directory: '/work', name: 'work', isRepository: true, branches: ['main'] } },
  },
  'model/list': { params: { force: 'local' }, badParams: { force: 'remote' }, result: { models: { models: [] } } },
  'draft/defaults': { params: {}, badParams: 'nope', result: { defaults: { model: 'm', approvalMode: 'ask' } } },
};

const notificationSamples: Record<HostNotificationName, { params: unknown; badParams: unknown }> = {
  'session/event': {
    params: { sessionId: 's1', seq: 1, event: { type: 'start', sessionId: 's1' } },
    badParams: { sessionId: 's1', seq: -1, event: {} },
  },
  'session/summaryChanged': { params: { summary }, badParams: { summary: null } },
  'session/statusChanged': { params: { event: sessionStatus }, badParams: { event: {} } },
  'session/queueChanged': {
    params: { event: { sessionId: 's1', queued: [queued] } },
    badParams: { event: { sessionId: 's1' } },
  },
  'session/taskDecisionsChanged': {
    params: { decisions: [{ sessionId: 's1', rootId: 'r1', title: 't', decision: { kind: 'stopped' } }] },
    badParams: { decisions: 'none' },
  },
  'host/stateChanged': { params: { account: null }, badParams: { account: { userId: 'u1' } } },
  'session/resyncRequired': { params: { sessionId: 's1' }, badParams: {} },
};

describe('hostMethods', () => {
  it('has a test sample for every method', () => {
    expect(Object.keys(methodSamples).sort()).toEqual(Object.keys(hostMethods).sort());
  });

  it.each(Object.keys(hostMethods) as HostMethod[])('%s accepts valid params and result, rejects bad params', name => {
    const { params, badParams, result } = methodSamples[name];
    expect(hostMethods[name].params.safeParse(params).success).toBe(true);
    expect(hostMethods[name].params.safeParse(badParams).success).toBe(false);
    expect(hostMethods[name].result.safeParse(result).success).toBe(true);
  });

  it('lets no-argument methods omit params, and session/create start a plain chat', () => {
    expect(hostMethods['host/info'].params.safeParse(undefined).success).toBe(true);
    expect(hostMethods['session/create'].params.safeParse(undefined).success).toBe(true);
    expect(hostMethods['fs/browse'].params.safeParse(undefined).success).toBe(true);
  });

  it('carries the archive question when a parent needs confirming, and rejects a malformed one', () => {
    const { result } = hostMethods['session/setArchived'];
    const confirmationRequired = {
      parentTitle: 'Parent',
      finished: [{ id: 'c1', title: 'Done' }],
      kept: [{ id: 'c2', title: 'Busy', status: 'running' }],
    };
    expect(result.safeParse({ summary: null, confirmationRequired }).success).toBe(true);
    expect(result.safeParse({ summary: null, confirmationRequired: { parentTitle: 'Parent' } }).success).toBe(false);
  });

  it('accepts the fs/browse result of a 1.0 host, which has no flags or truncation', () => {
    const legacy = { path: '/a', parent: '/', entries: [{ name: 'b', path: '/a/b', isGitRepository: false }] };
    expect(hostMethods['fs/browse'].result.safeParse(legacy).success).toBe(true);
  });

  it('accepts the session/delete params of a 1.1 client, which has no allowDiscard', () => {
    expect(hostMethods['session/delete'].params.safeParse({ sessionId: 's1', removeWorktree: true }).success).toBe(
      true
    );
  });

  it('rejects a session/deleteTree result without the list of what was deleted', () => {
    expect(hostMethods['session/deleteTree'].result.safeParse({ error: null }).success).toBe(false);
  });

  it('rejects a background/stop result whose process is not one', () => {
    expect(hostMethods['background/stop'].result.safeParse({}).success).toBe(true);
    expect(hostMethods['background/stop'].result.safeParse({ process: { id: 'p1' } }).success).toBe(false);
  });

  it('rejects a project/inspect result without the fields a client relies on', () => {
    expect(
      hostMethods['project/inspect'].result.safeParse({ inspection: { directory: '/w', isRepository: true } }).success
    ).toBe(false);
  });

  it('discriminates request/respond on kind', () => {
    const { params } = hostMethods['request/respond'];
    expect(
      params.safeParse({ kind: 'taskDecision', sessionId: 's1', decisionId: 'd1', answer: { status: 'skipped' } })
        .success
    ).toBe(true);
    expect(params.safeParse({ kind: 'taskDecision', requestId: 'r1', answer: { decision: 'once' } }).success).toBe(
      false
    );
    expect(params.safeParse({ kind: 'other', requestId: 'r1' }).success).toBe(false);
  });
});

describe('hostNotifications', () => {
  it('has a test sample for every notification', () => {
    expect(Object.keys(notificationSamples).sort()).toEqual(Object.keys(hostNotifications).sort());
  });

  it.each(Object.keys(hostNotifications) as HostNotificationName[])(
    '%s accepts valid params, rejects bad params',
    name => {
      const { params, badParams } = notificationSamples[name];
      expect(hostNotifications[name].params.safeParse(params).success).toBe(true);
      expect(hostNotifications[name].params.safeParse(badParams).success).toBe(false);
    }
  );
});

describe('hostErrorData', () => {
  it('types the data of a path that cannot be browsed and of an unknown process', () => {
    expect(hostErrorData.pathUnavailable.safeParse({ path: '/gone', reason: 'notFound' }).success).toBe(true);
    expect(hostErrorData.pathUnavailable.safeParse({ reason: 'notFound' }).success).toBe(false);
    expect(hostErrorData.processNotFound.safeParse({ sessionId: 's1', processId: 'p1' }).success).toBe(true);
    expect(hostErrorData.processNotFound.safeParse({ sessionId: 's1' }).success).toBe(false);
  });
});
