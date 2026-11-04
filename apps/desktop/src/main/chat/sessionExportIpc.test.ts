import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatSessionExportResult } from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';
import { registerSessionExportIpc } from './sessionExportIpc';

const SESSION = {
  id: 'session-1',
  title: 'A/B notes',
  model: 'test-model',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  mode: 'chat',
  messages: [{ id: 'm1', role: 'user', content: 'hello there', createdAt: '2026-10-01T00:00:00.000Z' }],
} as unknown as ChatSession;

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'b4m-session-export-'));
  const deps = {
    sessions: { get: vi.fn(async (id: string) => (id === SESSION.id ? SESSION : null)) },
    pickSavePath: vi.fn(async (_sender: unknown, _options: unknown): Promise<string | null> => null),
    writeFile: vi.fn(async (_path: string, _content: string) => {}),
    downloadsDirectory: () => join(directory, 'Downloads'),
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerSessionExportIpc(
    {
      handle: (channel: string, listener: (...args: never[]) => unknown) =>
        void handlers.set(channel, listener as never),
    },
    deps
  );
  const exportSession = (sessionId: unknown) =>
    handlers.get(IPC_CHANNELS.chatExportSession)!({ sender: {} }, sessionId) as Promise<ChatSessionExportResult>;
  return { directory, deps, exportSession };
}

describe('chat:export-session', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('offers a sanitized .md name in Downloads with both formats', async () => {
    await ctx.exportSession(SESSION.id);
    expect(ctx.deps.pickSavePath).toHaveBeenCalledWith(expect.anything(), {
      defaultPath: join(ctx.directory, 'Downloads', 'A-B notes.md'),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'JSON', extensions: ['json'] },
      ],
    });
  });

  it('writes nothing and reports not saved when the dialog is cancelled', async () => {
    await expect(ctx.exportSession(SESSION.id)).resolves.toEqual({ saved: false });
    expect(ctx.deps.writeFile).not.toHaveBeenCalled();
  });

  it('writes the stored record as JSON for a .json path', async () => {
    const path = join(ctx.directory, 'out.JSON');
    ctx.deps.pickSavePath.mockResolvedValueOnce(path);
    ctx.deps.writeFile.mockImplementationOnce(async (to, content) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(to, content, 'utf8');
    });
    await expect(ctx.exportSession(SESSION.id)).resolves.toEqual({ saved: true, path });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(SESSION);
  });

  it('writes Markdown for a .md path and for any other extension', async () => {
    ctx.deps.pickSavePath.mockResolvedValueOnce('/x/notes.md').mockResolvedValueOnce('/x/notes.txt');
    await ctx.exportSession(SESSION.id);
    await ctx.exportSession(SESSION.id);
    for (const [, content] of ctx.deps.writeFile.mock.calls) {
      expect(content.startsWith('# A/B notes\n')).toBe(true);
      expect(content).toContain('## User\n\nhello there');
    }
  });

  it('rejects an unknown session, a malformed id, and a failed write', async () => {
    await expect(ctx.exportSession('missing')).rejects.toThrow('no longer exists');
    await expect(ctx.exportSession(42)).rejects.toThrow('Not a notebook id');
    await expect(ctx.exportSession('../etc')).rejects.toThrow('Not a notebook id');
    expect(ctx.deps.pickSavePath).not.toHaveBeenCalled();

    ctx.deps.pickSavePath.mockResolvedValueOnce('/x/notes.md');
    ctx.deps.writeFile.mockRejectedValueOnce(new Error('disk full'));
    await expect(ctx.exportSession(SESSION.id)).rejects.toThrow('disk full');
  });
});
