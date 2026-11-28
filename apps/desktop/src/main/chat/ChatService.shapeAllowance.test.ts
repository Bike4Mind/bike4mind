import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatStreamEvent, ChatToolCall } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';
import type { ApprovalAlways, ApprovalPrompt, ToolContext, ToolDefinition } from './tools/types';

const SHAPE = '/p\x00cmd \x00X\x00';

const always = (overrides: Partial<ApprovalAlways> = {}): ApprovalAlways => ({
  namespace: 'bash_execute',
  commands: [{ text: 'x', pattern: 'x *', coverable: false }],
  directories: [],
  shape: SHAPE,
  ...overrides,
});

const promptWith = (overrides: Partial<ApprovalPrompt> = {}): ApprovalPrompt => ({
  detail: 'x',
  key: 'call-key',
  askInAuto: true,
  unchecked: true,
  always: always(),
  ...overrides,
});

/** A shell prompt whose "Allow in this chat" is remembered by command shape, answered by a covered shape. */
describe('ChatService shape allowance', () => {
  let service: ChatService;
  let approvals: ApprovalGate;
  let store: SessionStore;
  let events: ChatStreamEvent[];
  let sessionsDirectory: string;
  let sessionId: string;
  const signal = new AbortController().signal;

  beforeEach(async () => {
    const testEvents: ChatStreamEvent[] = [];
    events = testEvents;
    approvals = new ApprovalGate();
    sessionsDirectory = await mkdtemp(join(tmpdir(), 'b4m-shape-allowance-'));
    store = new SessionStore(sessionsDirectory, 'test-model');
    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      approvals,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => ({}) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => testEvents.push(event),
    });
    const created = await store.create('test-model');
    sessionId = created.id;
    await service.setApprovalMode(sessionId, 'auto');
    // Seeded the way a user's "always" on an earlier card for this shape is.
    const seeded = approvals.request(
      sessionId,
      'seed-key',
      signal,
      id => approvals.resolve(id, { decision: 'always' }),
      {
        always: always(),
      }
    );
    await seeded;
  });

  afterEach(async () => {
    service.dispose();
    await store.delete(sessionId);
    await rm(sessionsDirectory, { recursive: true, force: true });
  });

  const tool = (prompt: ApprovalPrompt): ToolDefinition =>
    ({
      schema: { name: 'bash_execute', description: 'x', parameters: { type: 'object', properties: {} } },
      approval: () => prompt,
      run: async () => 'ok',
    }) as unknown as ToolDefinition;

  type AwaitApproval = (
    tool: ToolDefinition,
    call: ChatToolCall,
    context: ToolContext,
    sessionId: string,
    messageId: string,
    signal: AbortSignal,
    looping: boolean
  ) => Promise<{ approval?: { decidedBy?: unknown }; settled?: ChatToolCall }>;

  const decide = async (prompt: ApprovalPrompt) => {
    const call: ChatToolCall = { id: 'c1', name: 'bash_execute', input: { command: 'x' }, status: 'running' };
    const context = { roots: [], signal } as unknown as ToolContext;
    const awaitApproval = (service as unknown as { awaitApproval: AwaitApproval }).awaitApproval.bind(service);
    const outcome = awaitApproval(tool(prompt), call, context, sessionId, 'm1', signal, false);
    return outcome;
  };

  const cards = (): ChatToolCall[] =>
    events
      .map(event => (event.type === 'tool-start' ? event.call : null))
      .filter((call): call is ChatToolCall => call !== null && call.status === 'awaiting-approval');

  /** Runs the prompt, expects a card to be requested, and declines it so the call settles. */
  const expectCard = async (prompt: ApprovalPrompt) => {
    const outcome = decide(prompt);
    const card = await vi.waitUntil(() => cards()[0], { timeout: 5000, interval: 5 });
    approvals.resolve(card.approvalId as string, { decision: 'deny' });
    await outcome;
    expect(cards()).toHaveLength(1);
  };

  it('runs a command of the allowed shape without a card', async () => {
    const outcome = await decide(promptWith());

    expect(outcome.settled).toBeUndefined();
    expect(outcome.approval?.decidedBy).toEqual({ kind: 'chat-allowance' });
    expect(cards()).toHaveLength(0);
  });

  it('asks when the tool allows this call only', async () => {
    await expectCard(promptWith({ allowOnce: true }));
  });

  it('asks about an irreversible call', async () => {
    await expectCard(promptWith({ irreversible: true }));
  });

  it('asks when the command writes in a folder the user has not allowed', async () => {
    const outside = join(sessionsDirectory, 'elsewhere');
    await expectCard(promptWith({ always: always({ directories: [outside], writtenDirectories: [outside] }) }));
  });

  it('asks about a command of a different shape', async () => {
    await expectCard(promptWith({ always: always({ shape: '/p\x00cmd \x00Y\x00' }) }));
  });
});
