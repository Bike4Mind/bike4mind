import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { registerKeepHandlers } from './registerKeepHandlers.js';

type Handler = (message: unknown) => Promise<void> | void;

/** Minimal fake of WebSocketConnectionManager that captures the action handler and sent responses. */
function createFakeWs() {
  const handlers: Record<string, Handler> = {};
  const sent: Array<Record<string, unknown>> = [];
  return {
    handlers,
    sent,
    onAction(action: string, handler: Handler) {
      handlers[action] = handler;
    },
    send(msg: Record<string, unknown>) {
      sent.push(msg);
    },
  };
}

describe('registerKeepHandlers', () => {
  let ws: ReturnType<typeof createFakeWs>;
  let invoke: (msg: Record<string, unknown>) => Promise<void>;

  beforeEach(() => {
    ws = createFakeWs();
    registerKeepHandlers(ws as never);
    const handler = ws.handlers['keep_command'];
    invoke = async msg => {
      await handler(msg);
    };
  });

  it('registers a keep_command action handler', () => {
    expect(typeof ws.handlers['keep_command']).toBe('function');
  });

  it('reads a file and returns its content', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'keep-test-'));
    const filePath = path.join(dir, 'hello.txt');
    await fs.writeFile(filePath, 'hello world', 'utf-8');

    await invoke({
      commandType: 'read_file',
      params: { path: filePath },
      requestId: 'r1',
      originConnectionId: 'conn-abcdef123456',
    });

    expect(ws.sent).toHaveLength(1);
    const resp = ws.sent[0];
    expect(resp.action).toBe('keep_command_response');
    expect(resp.requestId).toBe('r1');
    expect(resp.success).toBe(true);
    expect(resp.result).toEqual({ content: 'hello world', path: filePath });
    expect(resp.error).toBeUndefined();

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('lists a directory with file/dir flags', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'keep-test-'));
    await fs.writeFile(path.join(dir, 'a.txt'), 'a', 'utf-8');
    await fs.mkdir(path.join(dir, 'sub'));

    await invoke({ commandType: 'list_directory', params: { path: dir }, requestId: 'r2', originConnectionId: 'c' });

    const resp = ws.sent[0];
    expect(resp.success).toBe(true);
    const entries = resp.result as Array<{ name: string; isDirectory: boolean }>;
    expect(entries).toEqual(
      expect.arrayContaining([
        { name: 'a.txt', isDirectory: false },
        { name: 'sub', isDirectory: true },
      ])
    );

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns an error response for a missing required param', async () => {
    await invoke({ commandType: 'read_file', params: {}, requestId: 'r3', originConnectionId: 'c' });

    const resp = ws.sent[0];
    expect(resp.success).toBe(false);
    expect(resp.error).toBe('Missing required param: path');
    expect(resp.result).toBeUndefined();
  });

  it('returns an error response for an unknown command type', async () => {
    await invoke({ commandType: 'nope', params: {}, requestId: 'r4', originConnectionId: 'c' });

    const resp = ws.sent[0];
    expect(resp.success).toBe(false);
    expect(resp.error).toBe('Unknown command type: nope');
  });

  it('returns an error (not a throw) when Jupyter is not configured', async () => {
    const prev = process.env.JUPYTER_SERVER_URL;
    delete process.env.JUPYTER_SERVER_URL;

    await invoke({ commandType: 'jupyter_get_kernelspecs', params: {}, requestId: 'r5', originConnectionId: 'c' });

    const resp = ws.sent[0];
    expect(resp.success).toBe(false);
    expect(String(resp.error)).toContain('Jupyter not configured');

    if (prev !== undefined) process.env.JUPYTER_SERVER_URL = prev;
  });

  it('echoes requestId and originConnectionId back in every response', async () => {
    await invoke({ commandType: 'nope', params: {}, requestId: 'req-xyz', originConnectionId: 'origin-123' });
    const resp = ws.sent[0];
    expect(resp.requestId).toBe('req-xyz');
    expect(resp.originConnectionId).toBe('origin-123');
  });
});
