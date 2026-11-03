import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatApprovalMode, ChatStreamEvent, ChatToolCall } from '@shared/chat';
import type { PermissionList } from '@shared/permissions';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import { CapabilityLedger } from './capabilities/CapabilityLedger';
import { revokeSessionCapability } from './capabilities/approvalCapabilities';
import type { ApprovalLogEntry } from './permissions/ApprovalLog';
import { PermissionRuleSet, compileRule, parseRule, type CompiledRule, type RuleSource } from './permissions/rules';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';
import { bashExecute } from './tools/shellTools';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

const CLAUDE_CODE_USER: RuleSource = { id: 'cc-user', label: 'Claude Code user', path: '/x/settings.json' };

function ruleSet(
  lists: Partial<Record<PermissionList, string[]>>,
  source: RuleSource = CLAUDE_CODE_USER
): PermissionRuleSet {
  const compiled: CompiledRule[] = [];
  for (const [list, texts] of Object.entries(lists) as [PermissionList, string[]][]) {
    for (const text of texts) {
      const parsed = parseRule(text, { native: true });
      if (!parsed.ok) throw new Error(parsed.reason);
      const rule = compileRule(parsed.rule, list, source, { home: '/nowhere', root: null, cwd: null });
      if (rule) compiled.push(rule);
    }
  }
  return new PermissionRuleSet(compiled);
}

/**
 * The decision record on a gated call: who let it run or stopped it, kept on the settled row and
 * appended to the approval log, so a stop or a quit never reads as the user saying no.
 */
describe('ChatService approval record', () => {
  let service: ChatService;
  let store: SessionStore;
  let approvals: ApprovalGate;
  let capabilities: CapabilityLedger;
  let events: ChatStreamEvent[];
  let streams: PassThrough[];
  let root: string;
  let rules: PermissionRuleSet;
  let logged: ApprovalLogEntry[];
  let rememberAllows: Mock<(rules: readonly string[]) => Promise<void>>;

  const calls = (id: string, status: ChatToolCall['status']): ChatToolCall[] =>
    events
      .map(event => (event.type === 'tool-start' || event.type === 'tool-end' ? event.call : null))
      .filter((call): call is ChatToolCall => call !== null && call.id === id && call.status === status);

  const awaitCall = (id: string, status: ChatToolCall['status']) =>
    vi.waitUntil(() => calls(id, status)[0], { timeout: 5000, interval: 10 });

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-record-')));
    await writeFile(join(root, 'notes.txt'), 'hello\n', 'utf8');
    approvals = new ApprovalGate();
    capabilities = new CapabilityLedger(join(root, 'capabilities.json'));
    rules = ruleSet({});
    logged = [];
    rememberAllows = vi.fn<(rules: readonly string[]) => Promise<void>>().mockResolvedValue(undefined);
    const testRememberAllows = rememberAllows;
    vi.spyOn(bashExecute, 'run').mockResolvedValue('ok');
    const testEvents: ChatStreamEvent[] = [];
    const testStreams: PassThrough[] = [];
    const testLogged = logged;
    events = testEvents;
    streams = testStreams;
    const post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      testStreams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-record-sessions-')), 'test-model');
    service = new ChatService({
      store,
      access: { list: async () => [root] } as unknown as AccessStore,
      approvals,
      capabilities,
      permissions: {
        rulesFor: async () => rules,
        rememberAllows: rules => testRememberAllows(rules),
        invalidate: vi.fn(),
      },
      approvalLog: {
        append: async entry => {
          testLogged.push(entry);
        },
      },
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => testEvents.push(event),
    });
  });

  afterEach(() => {
    service.dispose();
    for (const stream of streams) stream.end();
    vi.restoreAllMocks();
  });

  function useTool(stream: PassThrough, id: string, command: string): void {
    stream.write(
      frame({
        type: 'tool_use',
        tools: [{ id, name: 'bash_execute', arguments: JSON.stringify({ command, cwd: root }) }],
      })
    );
    stream.write(frame('[DONE]'));
  }

  async function run(mode: ChatApprovalMode, command: string): Promise<string> {
    const created = await service.createSession();
    await service.setApprovalMode(created.id, mode);
    await service.send(created.id, 'go');
    await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
    useTool(streams[0], 'c1', command);
    return created.id;
  }

  it('records a call the mode let through unasked', async () => {
    await run('full', 'touch made.txt');
    const done = await awaitCall('c1', 'done');
    expect(done.approval).toMatchObject({
      outcome: 'allowed',
      decidedBy: { kind: 'mode', mode: 'full' },
      asked: false,
    });
    expect(done.approval?.requestedAt).toBeUndefined();
  });

  it('records the allow rule that ran a call in Ask, and logs it', async () => {
    rules = ruleSet({ allow: ['Bash(touch:*)'] });
    const sessionId = await run('ask', 'touch made.txt');
    const done = await awaitCall('c1', 'done');
    expect(done.approval).toMatchObject({
      outcome: 'allowed',
      decidedBy: { kind: 'rule', rule: 'Bash(touch:*)', source: 'Claude Code user' },
      asked: false,
    });
    await vi.waitUntil(() => logged.length === 1, { timeout: 5000, interval: 5 });
    expect(logged[0]).toMatchObject({
      sessionId,
      mode: 'ask',
      tool: 'bash_execute',
      input: 'touch made.txt',
      patterns: ['touch *'],
      approval: done.approval,
    });
  });

  it('records the deny rule that refused a call', async () => {
    rules = ruleSet({ deny: ['Bash(touch:*)'] });
    await run('full', 'touch made.txt');
    const denied = await awaitCall('c1', 'denied');
    expect(denied.approval).toMatchObject({
      outcome: 'denied',
      decidedBy: { kind: 'rule', rule: 'Bash(touch:*)' },
      asked: false,
    });
  });

  it('records a click on "Allow once" with when the card was shown', async () => {
    await run('ask', 'touch made.txt');
    const asked = await awaitCall('c1', 'awaiting-approval');
    approvals.resolve(asked.approvalId!, { decision: 'once' });
    const done = await awaitCall('c1', 'done');
    expect(done.approval).toMatchObject({
      outcome: 'allowed',
      decidedBy: { kind: 'user', answer: 'once' },
      asked: true,
    });
    expect(done.approval?.requestedAt).toEqual(expect.any(String));
  });

  it('records "Allow in this chat", then the standing answer it leaves for the next call', async () => {
    await run('ask', 'touch made.txt');
    const asked = await awaitCall('c1', 'awaiting-approval');
    approvals.resolve(asked.approvalId!, { decision: 'always' });
    const first = await awaitCall('c1', 'done');
    expect(first.approval?.decidedBy).toEqual({ kind: 'user', answer: 'always' });

    await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 5 });
    useTool(streams[1], 'c2', 'touch made.txt');
    const second = await awaitCall('c2', 'done');
    expect(second.approval).toMatchObject({ outcome: 'allowed', decidedBy: { kind: 'chat-allowance' }, asked: false });
  });

  it('keeps grant changes without writing a use event for each authorized call', async () => {
    await run('ask', 'touch made.txt');
    const asked = await awaitCall('c1', 'awaiting-approval');
    approvals.resolve(asked.approvalId!, { decision: 'always' });
    await awaitCall('c1', 'done');
    const firstState = await capabilities.state();
    expect(firstState.grants).toHaveLength(1);
    expect(firstState.audit.map(event => event.type)).toEqual(['grant']);

    await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 5 });
    useTool(streams[1], 'c2', 'touch made.txt');
    await awaitCall('c2', 'done');
    expect(await capabilities.state()).toEqual(firstState);
  });

  it('runs ungated reads without reading or writing the capability ledger', async () => {
    const use = vi.spyOn(capabilities, 'use').mockRejectedValue(new Error('ledger unavailable'));
    const grant = vi.spyOn(capabilities, 'grant').mockRejectedValue(new Error('ledger unavailable'));
    const created = await service.createSession();
    await service.send(created.id, 'read the notes');
    await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'read', name: 'file_read', arguments: JSON.stringify({ path: join(root, 'notes.txt') }) }],
      })
    );
    streams[0].write(frame('[DONE]'));
    const done = await awaitCall('read', 'done');
    expect(done.preview).toContain('hello');
    expect(use).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
  });

  it('revokes the exact shell allowance recorded by the live approval path', async () => {
    const sessionId = await run('ask', 'touch made.txt');
    const asked = await awaitCall('c1', 'awaiting-approval');
    approvals.resolve(asked.approvalId!, { decision: 'always' });
    await awaitCall('c1', 'done');
    const [grant] = (await capabilities.state()).grants;
    expect(grant).toMatchObject({
      subject: { kind: 'session', sessionId, scopeKey: store.scopeKey() },
      capability: 'tool',
    });
    expect(grant.approvalKey).toEqual(expect.any(String));
    await capabilities.revoke(grant.id, entry => revokeSessionCapability(entry, approvals));

    await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 5 });
    useTool(streams[1], 'c2', 'touch made.txt');
    const askedAgain = await awaitCall('c2', 'awaiting-approval');
    approvals.resolve(askedAgain.approvalId!, { decision: 'deny' });
    await awaitCall('c2', 'denied');
  });

  it('tells the model the user declined only when the user did', async () => {
    await run('ask', 'touch made.txt');
    const asked = await awaitCall('c1', 'awaiting-approval');
    approvals.resolve(asked.approvalId!, { decision: 'deny' });
    const denied = await awaitCall('c1', 'denied');
    expect(denied.approval).toMatchObject({ outcome: 'denied', decidedBy: { kind: 'user', answer: 'deny' } });
    expect(denied.error).toContain('The user declined to run this');
  });

  it('records a stop as closing the card, not as the user declining', async () => {
    const sessionId = await run('ask', 'touch made.txt');
    await awaitCall('c1', 'awaiting-approval');
    service.stop(sessionId);
    const denied = await awaitCall('c1', 'denied');
    expect(denied.approval).toMatchObject({
      outcome: 'denied',
      decidedBy: { kind: 'system', reason: 'stopped' },
      asked: true,
    });
    expect(denied.error).toBe('Not run: the reply was stopped before this was approved.');
    expect(denied.error).not.toContain('declined');
  });

  it('logs the mode the decision was made under, not the one stored by the time it is written', async () => {
    const get = store.get.bind(store);
    // The gate decides under 'full', while the session as read back for its title already
    // carries a later 'ask' - what a mode switch landing between the two would look like.
    vi.spyOn(store, 'approvalMode').mockResolvedValue('full');
    vi.spyOn(store, 'get').mockImplementation(async id => {
      const session = await get(id);
      return session ? { ...session, approvalMode: 'ask' } : session;
    });
    await run('full', 'touch made.txt');
    await awaitCall('c1', 'done');
    await vi.waitUntil(() => logged.length === 1, { timeout: 5000, interval: 5 });
    expect(logged[0]).toMatchObject({ mode: 'full', approval: { decidedBy: { kind: 'mode', mode: 'full' } } });
  });

  it('records a card closed before it was shown as never asked', async () => {
    vi.spyOn(approvals, 'request').mockResolvedValue({ decision: 'deny', settledBy: 'stopped', asked: false });
    await run('ask', 'touch made.txt');
    const denied = await awaitCall('c1', 'denied');
    expect(denied.approval).toMatchObject({
      outcome: 'denied',
      decidedBy: { kind: 'system', reason: 'stopped' },
      asked: false,
    });
    expect(denied.approval?.requestedAt).toBeUndefined();
  });

  it('does not record "every session" when saving the rule failed', async () => {
    rememberAllows.mockRejectedValue(new Error('disk full'));
    await run('ask', 'touch made.txt');
    const asked = await awaitCall('c1', 'awaiting-approval');
    expect(asked.approvalRules?.length).toBeGreaterThan(0);
    approvals.resolve(asked.approvalId!, { decision: 'always', everywhere: true });
    const done = await awaitCall('c1', 'done');
    expect(rememberAllows).toHaveBeenCalled();
    expect(done.approval?.decidedBy).toEqual({ kind: 'user', answer: 'always' });
    expect((await capabilities.state()).grants).toHaveLength(1);
    expect((await capabilities.state()).grants[0].subject.kind).toBe('session');
  });

  it('records a card closed by deleting the conversation as that, not as a refusal', async () => {
    const sessionId = await run('ask', 'touch made.txt');
    await awaitCall('c1', 'awaiting-approval');
    await service.deleteSession(sessionId);
    const denied = await awaitCall('c1', 'denied');
    expect(denied.approval).toMatchObject({
      outcome: 'denied',
      decidedBy: { kind: 'system', reason: 'conversation-deleted' },
      asked: true,
    });
    expect(denied.error).toBe('Not run: the conversation was deleted before this was approved.');
    expect(denied.error).not.toContain('declined');
  });

  it('records a card closed by the app quitting as that, not as a refusal', async () => {
    await run('ask', 'touch made.txt');
    await awaitCall('c1', 'awaiting-approval');
    service.dispose();
    const denied = await awaitCall('c1', 'denied');
    expect(denied.approval).toMatchObject({
      outcome: 'denied',
      decidedBy: { kind: 'system', reason: 'app-quit' },
      asked: true,
    });
    expect(denied.error).toBe('Not run: the app quit before this was approved.');
    expect(denied.error).not.toContain('declined');
  });

  it('records "every session" once the rule was saved', async () => {
    await run('ask', 'touch made.txt');
    const asked = await awaitCall('c1', 'awaiting-approval');
    approvals.resolve(asked.approvalId!, { decision: 'always', everywhere: true });
    const done = await awaitCall('c1', 'done');
    expect(rememberAllows).toHaveBeenCalled();
    expect(done.approval?.decidedBy).toEqual({ kind: 'user', answer: 'always', everywhere: true });
  });

  it('saves no rule when a stop closes the card', async () => {
    const sessionId = await run('ask', 'touch made.txt');
    const asked = await awaitCall('c1', 'awaiting-approval');
    service.stop(sessionId);
    await awaitCall('c1', 'denied');
    approvals.resolve(asked.approvalId!, { decision: 'always', everywhere: true });
    await Promise.resolve();
    expect(rememberAllows).not.toHaveBeenCalled();
  });

  it('keeps the record on the stored transcript', async () => {
    const sessionId = await run('full', 'touch made.txt');
    await awaitCall('c1', 'done');
    await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 5 });
    streams[1].write(frame({ type: 'content', text: 'done', stopReason: 'end_turn' }));
    streams[1].write(frame('[DONE]'));
    const stored = await vi.waitUntil(
      async () => {
        const session = await store.get(sessionId);
        return session?.messages.flatMap(message => message.toolCalls ?? []).find(call => call.id === 'c1');
      },
      { timeout: 5000, interval: 10 }
    );
    expect(stored.approval).toMatchObject({ outcome: 'allowed', decidedBy: { kind: 'mode', mode: 'full' } });
  });
});
