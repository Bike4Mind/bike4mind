import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatStreamEvent } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import { ProjectTrustStore } from './skills/ProjectTrustStore';
import { SkillCatalog } from './skills/SkillCatalog';
import type { AccessStore } from './tools/AccessStore';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

async function skill(project: string, name: string, lines: readonly string[]): Promise<void> {
  const directory = join(project, '.claude', 'skills', name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), lines.join('\n'), 'utf8');
}

/**
 * The half the renderer never sees: what the MODEL is told about skills, and what it may call.
 *
 * Expansion itself is covered by expand.test.ts and the gate by SkillCatalog.test.ts; what is
 * proven here is that the two reach a real turn - the list in the system prompt and the tool in
 * the declared set - and that neither carries a project the user has not trusted.
 */
describe('ChatService and skills', () => {
  let service: ChatService;
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let project: string;
  let catalog: SkillCatalog;

  beforeEach(async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-chatskills-')));
    project = join(base, 'repo');
    await mkdir(project, { recursive: true });
    await skill(project, 'ship-it', ['---', 'description: Use whenever the user asks to release.', '---', '', 'Ship.']);
    await skill(project, 'my-notes', [
      '---',
      'description: Mine alone.',
      'disable-model-invocation: true',
      '---',
      '',
      'Notes.',
    ]);

    catalog = new SkillCatalog(new ProjectTrustStore(join(base, 'trust.json')));
    events = [];
    streams = [];
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    service = new ChatService({
      store: new SessionStore(join(base, 'sessions'), 'test-model'),
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      userInstructionsRoot: join(base, 'user'),
      skills: catalog,
      emit: event => events.push(event),
    });
  });

  async function turn(sessionId: string, text: string, expectedPosts: number): Promise<Record<string, unknown>> {
    await service.send(sessionId, text);
    await vi.waitUntil(() => post.mock.calls.length === expectedPosts, { timeout: 3000, interval: 5 });
    const stream = streams[expectedPosts - 1];
    stream.write(frame({ type: 'content', text: 'ok', stopReason: 'end_turn' }));
    stream.write(frame('[DONE]'));
    await vi.waitUntil(() => events.filter(event => event.type === 'done').length === expectedPosts, {
      timeout: 3000,
      interval: 5,
    });
    return post.mock.calls[expectedPosts - 1][1];
  }

  async function session(): Promise<string> {
    const created = await service.createCodeSession({ directory: project, branch: '', workspace: false });
    if (!created.ok) throw new Error(created.error);
    return created.session.id;
  }

  const systemText = (body: Record<string, unknown>): string =>
    String((body.messages as { content: string }[])[0].content);
  const toolNames = (body: Record<string, unknown>): string[] =>
    ((body.options as { tools: { toolSchema: { name: string } }[] }).tools ?? []).map(entry => entry.toolSchema.name);

  it('declares the skill tool and lists the trusted project skills for the model', async () => {
    const id = await session();
    await catalog.setTrusted(project, true);

    const body = await turn(id, 'hello', 1);
    expect(toolNames(body)).toContain('skill');
    expect(systemText(body)).toContain('ship-it');
    expect(systemText(body)).toContain('Use whenever the user asks to release.');
  });

  it('leaves a not-model-invocable skill out of the list entirely', async () => {
    const id = await session();
    await catalog.setTrusted(project, true);

    expect(systemText(await turn(id, 'hello', 1))).not.toContain('my-notes');
  });

  it('lists nothing from a project the user has not trusted', async () => {
    const id = await session();
    expect(systemText(await turn(id, 'hello', 1))).not.toContain('ship-it');
  });

  it('keeps the system prompt byte-identical across turns, so the cached prefix holds', async () => {
    const id = await session();
    await catalog.setTrusted(project, true);

    const first = systemText(await turn(id, 'first', 1));
    await skill(project, 'late-arrival', ['---', 'description: Added mid-session.', '---', '', 'Late.']);
    expect(systemText(await turn(id, 'second', 2))).toBe(first);
  });
});
