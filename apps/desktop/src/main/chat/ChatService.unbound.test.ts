import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { fileRead, globFiles } from './tools/fileTools';
import { resolveWithinRoots } from './tools/paths';
import { resolveCwd } from './tools/shellTools';
import type { ToolContext } from './tools/types';

/**
 * A Code session that has chosen no project yet.
 *
 * It exists so that starting one never depends on completing a native dialog, and the whole
 * risk of allowing it is that a session with no working directory would silently run the
 * agent's commands wherever a global grant happens to point. These tests pin both halves: the
 * turn is refused, and the tool scope it would have been given is empty.
 */
describe('an unbound Code session', () => {
  let store: SessionStore;
  let service: ChatService;
  /** Folders granted app-wide - exactly what an unbound session must NOT inherit. */
  let granted: string[];

  beforeEach(async () => {
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-unbound-')), 'test-model');
    granted = ['/Users/someone/Documents'];
    service = new ChatService({
      store,
      access: { list: async () => granted } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      // Signed in, so a refusal below is about the missing project and nothing else.
      getApiClient: () => ({}) as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: vi.fn(),
    });
  });

  it('is created with no directory at all, and is still a Code session', async () => {
    const created = await service.createCodeSession({});
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.session.mode).toBe('code');
    expect(created.session.project).toBeUndefined();
  });

  it('survives a round trip through the store rather than being downgraded to Chat', async () => {
    const created = await service.createCodeSession({});
    if (!created.ok) throw new Error(created.error);

    const reloaded = await store.get(created.session.id);
    expect(reloaded?.mode).toBe('code');
    expect(reloaded?.project).toBeUndefined();
    expect((await store.list()).find(entry => entry.id === created.session.id)?.mode).toBe('code');
  });

  it('refuses a turn instead of running one with nowhere to run it', async () => {
    const created = await service.createCodeSession({});
    if (!created.ok) throw new Error(created.error);

    const sent = await service.send(created.session.id, 'list the files here');
    expect(sent.ok).toBe(false);
    if (sent.ok) return;
    expect(sent.error).toMatch(/choose a project folder/i);
  });

  it('is granted no roots, so it cannot inherit an app-wide folder grant', async () => {
    const created = await service.createCodeSession({});
    if (!created.ok) throw new Error(created.error);
    const session = await store.get(created.session.id);
    if (!session) throw new Error('session vanished');

    // resolveToolScope is private; it is the only thing that builds a tool scope, so it is
    // reached the way ChatService reaches it rather than reimplemented here.
    const scope = await (
      service as unknown as {
        resolveToolScope(s: typeof session): Promise<{ roots: readonly string[]; workingDirectory?: string }>;
      }
    ).resolveToolScope(session);

    expect(scope.roots).toEqual([]);
    expect(scope.workingDirectory).toBeUndefined();
  });

  it('still gives a Chat session the app-wide grants, which is the case this must not change', async () => {
    const chat = await service.createSession();
    const session = await store.get(chat.id);
    if (!session) throw new Error('session vanished');

    const scope = await (
      service as unknown as {
        resolveToolScope(s: typeof session): Promise<{ roots: readonly string[] }>;
      }
    ).resolveToolScope(session);

    expect(scope.roots).toEqual(granted);
  });

  it('becomes an ordinary Code session once the chips bind it to a folder', async () => {
    const created = await service.createCodeSession({});
    if (!created.ok) throw new Error(created.error);
    const directory = await mkdtemp(join(tmpdir(), 'b4m-unbound-project-'));

    const bound = await service.updateProject({ sessionId: created.session.id, directory });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.session.project?.workingDirectory).toBe(directory);

    const session = await store.get(created.session.id);
    if (!session) throw new Error('session vanished');
    const scope = await (
      service as unknown as {
        resolveToolScope(s: typeof session): Promise<{ roots: readonly string[]; workingDirectory?: string }>;
      }
    ).resolveToolScope(session);
    expect(scope.workingDirectory).toBe(directory);
    expect(scope.roots).toContain(directory);
  });
});

/**
 * What every tool does with the scope an unbound Code session resolves to.
 *
 * The scope above is the guard; this is the proof that the guard means something. Each of
 * these would otherwise have a fallback - `roots[0]` for a command's cwd and for a relative
 * glob - and landing in whichever folder was granted first is exactly the silent
 * mis-rooting this state had to be checked against before it was allowed to exist.
 */
describe('tools handed no roots and no working directory', () => {
  const context: ToolContext = { roots: [], signal: new AbortController().signal };

  it('refuses to pick a working directory for a command', async () => {
    await expect(resolveCwd({}, context.roots, context.workingDirectory)).rejects.toThrow(/no folder has been shared/i);
  });

  it('refuses even when the model names a directory itself', async () => {
    await expect(resolveCwd({ cwd: tmpdir() }, context.roots, context.workingDirectory)).rejects.toThrow(
      /access denied/i
    );
  });

  it('denies every path, absolute or relative', async () => {
    await expect(resolveWithinRoots('/etc/hosts', context.roots)).rejects.toThrow(/access denied/i);
    await expect(resolveWithinRoots('notes.txt', context.roots)).rejects.toThrow(/access denied/i);
  });

  it('refuses to read a file', async () => {
    await expect(fileRead.run({ path: '/etc/hosts' }, context)).rejects.toThrow(/access denied/i);
  });

  it('refuses a glob rather than anchoring it somewhere of its own choosing', async () => {
    await expect(globFiles.run({ pattern: '*.txt' }, context)).rejects.toThrow(/no folder has been shared/i);
  });
});
