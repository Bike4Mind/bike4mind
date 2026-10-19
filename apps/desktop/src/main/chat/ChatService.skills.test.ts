import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { RemoteSkillSource } from '@bike4mind/cli/skills';
import type { ChatStreamEvent, ChatToolCall } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import { ProjectTrustStore } from './skills/ProjectTrustStore';
import { remoteSkillsKey } from './skills/accountSkills';
import { SkillCatalog, type RemoteSkills } from './skills/SkillCatalog';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';

/** A `gh` stub first on PATH, so a command the gate lets through never reaches GitHub. */
const fakeBin = vi.hoisted(() => ({ dir: '' }));
vi.mock('./tools/userPath', () => ({ resolveUserPath: vi.fn(async () => `${fakeBin.dir}:/usr/bin:/bin`) }));

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
    fakeBin.dir = join(base, 'bin');
    await mkdir(fakeBin.dir);
    await writeFile(join(fakeBin.dir, 'gh'), '#!/bin/sh\necho "gh $*"\n', 'utf8');
    await chmod(join(fakeBin.dir, 'gh'), 0o755);
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

    // The account's own skill, available in every posture - including the untrusted project a
    // code session starts in - so the send path is exercised against a real RemoteSkillSource.
    const accountSkills: RemoteSkills = () => {
      const api = {
        get: async () => ({
          data: [
            {
              id: 'a1',
              name: 'web-summary',
              description: 'Summarise a page.',
              body: 'Summarise $ARGUMENTS',
              userId: 'me',
            },
          ],
        }),
        getCurrentUser: async () => ({ id: 'me' }),
      } as unknown as ConstructorParameters<typeof RemoteSkillSource>[0];
      const key = remoteSkillsKey('http://localhost:3000', 'me');
      return { key, source: new RemoteSkillSource(api, { cacheFilePath: join(base, `${key}.json`) }) };
    };
    catalog = new SkillCatalog(new ProjectTrustStore(join(base, 'trust.json')), accountSkills);
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
      approvals: new ApprovalGate(),
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

  const card = () =>
    events
      .map(event => (event.type === 'tool-start' ? event.call : null))
      .find((call): call is ChatToolCall => call?.status === 'awaiting-approval');

  async function afterSkill(id: string, name: string, next: { name: string; input: Record<string, unknown> }) {
    await service.setApprovalMode(id, 'auto');
    await service.send(id, 'go');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    streams[0].write(
      frame({ type: 'tool_use', tools: [{ id: 'c1', name: 'skill', arguments: JSON.stringify({ skill: name }) }] })
    );
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(() => streams.length === 2, { timeout: 3000, interval: 5 });
    streams[1].write(
      frame({ type: 'tool_use', tools: [{ id: 'c2', name: next.name, arguments: JSON.stringify(next.input) }] })
    );
    streams[1].write(frame('[DONE]'));
  }

  /** The user's own skill file is their instruction, so what it asks for runs as if they typed it. */
  it('runs an outbound command unasked in "Approve for me" after a local skill', async () => {
    const id = await session();
    await catalog.setTrusted(project, true);
    const command = 'gh issue edit 889 --add-assignee "@me" && gh issue view 889 --json title,body';
    await afterSkill(id, 'ship-it', { name: 'bash_execute', input: { command, cwd: project } });

    const settled = await vi.waitUntil(
      () =>
        events.find(
          event => event.type === 'tool-end' && event.call.name === 'bash_execute' && event.call.status === 'done'
        ),
      { timeout: 3000, interval: 5 }
    );
    expect(settled.type === 'tool-end' && settled.call.preview).toContain('gh issue edit 889');
    expect(card()).toBeUndefined();
  });

  it('asks in "Approve for me" before an outbound call that follows a skill the account served', async () => {
    const id = await session();
    await afterSkill(id, 'web-summary', { name: 'web_fetch', input: { url: 'https://example.com/' } });

    const asked = await vi.waitUntil(card, { timeout: 3000, interval: 5 });
    expect(asked.name).toBe('web_fetch');
    expect(asked.approvalDetail).toContain('Asking because this reply read a skill from your account (skill).');
  });

  it('keeps the system prompt byte-identical across turns, so the cached prefix holds', async () => {
    const id = await session();
    await catalog.setTrusted(project, true);

    const first = systemText(await turn(id, 'first', 1));
    await skill(project, 'late-arrival', ['---', 'description: Added mid-session.', '---', '', 'Late.']);
    expect(systemText(await turn(id, 'second', 2))).toBe(first);
  });

  it('records an account skill send as account, so the thread can label it', async () => {
    const id = await session();

    await turn(id, '/web-summary the release notes', 1);
    expect((await service.getSession(id))?.messages[0]?.skill).toEqual({
      name: 'web-summary',
      args: 'the release notes',
      source: 'account',
    });
  });
});
