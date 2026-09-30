import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatStreamEvent, ChatToolCall } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function bashTurn(id: string, command: string): string {
  return frame({
    type: 'tool_use',
    tools: [{ id, name: 'bash_execute', arguments: JSON.stringify({ command }) }],
  });
}

describe('ChatService approval gate', () => {
  let service: ChatService;
  let approvals: ApprovalGate;
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let root: string;

  const toolEvents = (status: ChatToolCall['status']) =>
    events.filter(event => (event.type === 'tool-start' || event.type === 'tool-end') && event.call.status === status);

  /** The id announced with the 'awaiting-approval' event, which is the only place it appears. */
  async function pendingApprovalId(): Promise<string> {
    const event = await vi.waitUntil(() => toolEvents('awaiting-approval')[0], { timeout: 3000, interval: 5 });
    if (event.type !== 'tool-start' || !event.call.approvalId) throw new Error('no approval announced');
    return event.call.approvalId;
  }

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-approve-')));
    approvals = new ApprovalGate();
    events = [];
    streams = [];
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });

    service = new ChatService({
      store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-approve-sessions-')), 'test-model'),
      access: { list: async () => [root] } as unknown as AccessStore,
      approvals,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => events.push(event),
    });
  });

  it('declares bash_execute alongside the file tools', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'hi');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    const declared = post.mock.calls[0][1].options.tools.map(
      (entry: { toolSchema: { name: string } }) => entry.toolSchema.name
    );
    expect(declared).toContain('bash_execute');
  });

  /** The point of the gate: nothing has run, and the turn has not advanced, until the user answers. */
  it('holds the command at the gate and runs nothing until the user answers', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'what is on port 3000?');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(bashTurn('call_1', 'echo ran-without-asking'));
    streams[0].write(frame('[DONE]'));

    const announced = await pendingApprovalId();
    expect(announced).toBeTruthy();

    // No second request, so no tool_result: the tool has not been run.
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(post).toHaveBeenCalledTimes(1);
    expect(toolEvents('running')).toHaveLength(0);
  });

  it('runs the command once allowed, and feeds its output back to the model', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'run it');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(bashTurn('call_1', 'echo approved-and-ran'));
    streams[0].write(frame('[DONE]'));
    approvals.resolve(await pendingApprovalId(), { decision: 'once' });

    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 5000, interval: 10 });
    const result = post.mock.calls[1][1].messages[3].content[0];
    expect(result.content).toContain('approved-and-ran');
    expect(result.is_error).toBeUndefined();
  });

  it('tells the model it was declined, without ending the turn', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'run it');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(bashTurn('call_1', 'echo should-never-run'));
    streams[0].write(frame('[DONE]'));
    approvals.resolve(await pendingApprovalId(), { decision: 'deny' });

    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 3000, interval: 5 });
    const result = post.mock.calls[1][1].messages[3].content[0];
    expect(result).toMatchObject({ type: 'tool_result', is_error: true });
    expect(result.content).toMatch(/declined/);

    // The conversation carries on: the model gets to say something about the refusal.
    streams[1].write(frame({ type: 'content', text: 'Understood, I will not run that.' }));
    streams[1].write(frame('[DONE]'));
    await expect(
      vi.waitUntil(() => events.find(event => event.type === 'done'), { timeout: 3000, interval: 5 })
    ).resolves.toMatchObject({ content: 'Understood, I will not run that.' });
  });

  it('stops asking for a command the user allowed always, and still asks for a different one', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'run it twice');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(bashTurn('call_1', 'echo repeated'));
    streams[0].write(frame('[DONE]'));
    approvals.resolve(await pendingApprovalId(), { decision: 'always' });

    await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 10 });
    streams[1].write(bashTurn('call_2', 'echo repeated'));
    streams[1].write(frame('[DONE]'));

    // Straight through the gate: a third request means it ran without asking again.
    await vi.waitUntil(() => streams.length === 3, { timeout: 5000, interval: 10 });
    expect(toolEvents('awaiting-approval')).toHaveLength(1);

    streams[2].write(bashTurn('call_3', 'echo something-else'));
    streams[2].write(frame('[DONE]'));
    await vi.waitUntil(() => toolEvents('awaiting-approval').length === 2, { timeout: 3000, interval: 5 });
  });

  it('does not gate the read-only file tools', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'list files');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'c1', name: 'glob_files', arguments: JSON.stringify({ pattern: '*' }) }],
      })
    );
    streams[0].write(frame('[DONE]'));

    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 3000, interval: 5 });
    expect(toolEvents('awaiting-approval')).toHaveLength(0);
  });

  it('denies a pending approval when the reply is stopped, rather than leaving it hanging', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'run it');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(bashTurn('call_1', 'echo should-never-run'));
    streams[0].write(frame('[DONE]'));
    await pendingApprovalId();

    service.stop(id);

    const done = await vi.waitUntil(() => events.find(event => event.type === 'done'), { timeout: 3000, interval: 5 });
    expect(done).toMatchObject({ stopReason: 'aborted' });
    expect(toolEvents('running')).toHaveLength(0);
  });
});
