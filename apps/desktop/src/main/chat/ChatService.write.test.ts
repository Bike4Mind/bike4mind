import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
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

function toolTurn(id: string, name: string, input: Record<string, unknown>): string {
  return frame({ type: 'tool_use', tools: [{ id, name, arguments: JSON.stringify(input) }] });
}

describe('ChatService write gate', () => {
  let service: ChatService;
  let approvals: ApprovalGate;
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let root: string;
  let outside: string;
  let target: string;

  const toolEvents = (status: ChatToolCall['status']) =>
    events.filter(event => (event.type === 'tool-start' || event.type === 'tool-end') && event.call.status === status);

  async function pendingApproval(): Promise<ChatToolCall> {
    const event = await vi.waitUntil(() => toolEvents('awaiting-approval')[0], { timeout: 3000, interval: 5 });
    if (event.type !== 'tool-start') throw new Error('no approval announced');
    return event.call;
  }

  /** The tool_result block the NEXT request carries back to the model. */
  function lastToolResult(): { content: string; is_error?: boolean } {
    const calls = post.mock.calls;
    return calls[calls.length - 1][1].messages[3].content[0];
  }

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-write-gate-')));
    outside = await realpath(await mkdtemp(join(tmpdir(), 'b4m-write-outside-')));
    target = join(root, 'notes.md');
    await writeFile(target, 'alpha\nbeta\ngamma\n', 'utf8');

    approvals = new ApprovalGate();
    events = [];
    streams = [];
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });

    service = new ChatService({
      store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-write-sessions-')), 'test-model'),
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

  async function startTurn(prompt: string): Promise<void> {
    const { id } = await service.createSession();
    await service.send(id, prompt);
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
  }

  // The whole point of T11: the user answers a diff, not a filename.
  it('shows the diff before asking, with the file still untouched', async () => {
    await startTurn('fix the second line');
    streams[0].write(toolTurn('c1', 'file_edit', { path: target, oldText: 'beta', newText: 'BETA' }));
    streams[0].write(frame('[DONE]'));

    const call = await pendingApproval();
    expect(call.approvalDiff).toMatchObject({ path: target, operation: 'edit', added: 1, removed: 1 });
    expect(call.approvalDiff?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'remove', text: 'beta' }),
        expect.objectContaining({ kind: 'add', text: 'BETA' }),
      ])
    );

    await expect(readFile(target, 'utf8')).resolves.toBe('alpha\nbeta\ngamma\n');
  });

  it('writes only once the user approves, and tells the model what landed', async () => {
    await startTurn('fix the second line');
    streams[0].write(toolTurn('c1', 'file_edit', { path: target, oldText: 'beta', newText: 'BETA' }));
    streams[0].write(frame('[DONE]'));

    const call = await pendingApproval();
    approvals.resolve(call.approvalId as string, { decision: 'once' });

    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 5000, interval: 10 });
    await expect(readFile(target, 'utf8')).resolves.toBe('alpha\nBETA\ngamma\n');
    expect(lastToolResult()).toMatchObject({ content: expect.stringContaining('Written') });
    expect(lastToolResult().is_error).toBeUndefined();
  });

  it('leaves the file alone when the user declines, and says so to the model', async () => {
    await startTurn('rewrite it');
    streams[0].write(toolTurn('c1', 'file_write', { path: target, content: 'replaced\n' }));
    streams[0].write(frame('[DONE]'));

    const call = await pendingApproval();
    approvals.resolve(call.approvalId as string, { decision: 'deny' });

    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 5000, interval: 10 });
    await expect(readFile(target, 'utf8')).resolves.toBe('alpha\nbeta\ngamma\n');
    expect(lastToolResult()).toMatchObject({ is_error: true, content: expect.stringMatching(/declined/) });
  });

  // Refused, not prompted-around: a write outside the grant never reaches the user as a
  // dialog they could tire of and click through.
  it('refuses a write outside the granted folder without asking the user at all', async () => {
    await startTurn('write to my other folder');
    streams[0].write(toolTurn('c1', 'file_write', { path: join(outside, 'x.txt'), content: 'nope\n' }));
    streams[0].write(frame('[DONE]'));

    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 5000, interval: 10 });
    expect(toolEvents('awaiting-approval')).toHaveLength(0);
    expect(toolEvents('denied')).toHaveLength(1);
    expect(lastToolResult()).toMatchObject({ is_error: true, content: expect.stringMatching(/outside the folders/) });
  });

  it('reports a bad edit as an error the model can correct', async () => {
    await startTurn('change epsilon');
    streams[0].write(toolTurn('c1', 'file_edit', { path: target, oldText: 'epsilon', newText: 'x' }));
    streams[0].write(frame('[DONE]'));

    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 5000, interval: 10 });
    expect(toolEvents('awaiting-approval')).toHaveLength(0);
    expect(toolEvents('error')).toHaveLength(1);
    expect(lastToolResult()).toMatchObject({ is_error: true, content: expect.stringMatching(/does not appear/) });
  });

  // T34. The transcript keeps these rows for good, so a diff on one is a claim about the past:
  // it is there when the bytes went down and absent every other time.
  describe('the diff kept on the settled call', () => {
    /** The call as one of those events carries it. `toolEvents` only filters; this narrows. */
    const callWith = (status: ChatToolCall['status']): ChatToolCall | undefined => {
      const event = toolEvents(status)[0];
      return event && 'call' in event ? event.call : undefined;
    };

    it('records what the write changed, once it has changed it', async () => {
      await startTurn('fix the second line');
      streams[0].write(toolTurn('c1', 'file_edit', { path: target, oldText: 'beta', newText: 'BETA' }));
      streams[0].write(frame('[DONE]'));

      const call = await pendingApproval();
      approvals.resolve(call.approvalId as string, { decision: 'once' });
      await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 5000, interval: 10 });

      expect(callWith('done')?.diff).toMatchObject({ path: target, operation: 'edit', added: 1, removed: 1 });
      expect(callWith('done')?.diff?.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'remove', text: 'beta' }),
          expect.objectContaining({ kind: 'add', text: 'BETA' }),
        ])
      );
    });

    it('leaves none on a write the user declined', async () => {
      await startTurn('rewrite it');
      streams[0].write(toolTurn('c1', 'file_write', { path: target, content: 'replaced\n' }));
      streams[0].write(frame('[DONE]'));

      const call = await pendingApproval();
      approvals.resolve(call.approvalId as string, { decision: 'deny' });
      await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 5000, interval: 10 });

      expect(callWith('denied')?.diff).toBeUndefined();
    });

    // The diff is built before the write, so this is the case that decides whether it is an
    // intention or a record: the plan was made, and then nothing was written.
    it('leaves none on a write the stale-file check refused', async () => {
      await startTurn('fix the second line');
      streams[0].write(toolTurn('c1', 'file_edit', { path: target, oldText: 'beta', newText: 'BETA' }));
      streams[0].write(frame('[DONE]'));

      const call = await pendingApproval();
      await writeFile(target, 'alpha\nsomeone else got here\ngamma\n', 'utf8');
      approvals.resolve(call.approvalId as string, { decision: 'once' });
      await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 5000, interval: 10 });

      expect(toolEvents('error')).toHaveLength(1);
      expect(callWith('error')?.diff).toBeUndefined();
      await expect(readFile(target, 'utf8')).resolves.toBe('alpha\nsomeone else got here\ngamma\n');
    });
  });
});
