import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatApprovalMode, ChatStreamEvent, ChatToolCall } from '@shared/chat';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';
import { bashExecute } from './tools/shellTools';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function toolTurn(id: string, name: string, input: Record<string, unknown>): string {
  return frame({ type: 'tool_use', tools: [{ id, name, arguments: JSON.stringify(input) }] });
}

type Round = [string, Record<string, unknown>];

// Tool stubs first on PATH. These tests check approval decisions; spawning real git or package
// runners can outlast the 5 s settle wait on a loaded CI machine.
const stub = vi.hoisted(() => ({ bin: '' }));
vi.mock('./tools/userPath', () => ({ resolveUserPath: async () => `${stub.bin}:${process.env.PATH ?? ''}` }));

describe('ChatService running a script written in the same session', () => {
  let service: ChatService;
  let approvals: ApprovalGate;
  let events: ChatStreamEvent[];
  let streams: PassThrough[];
  let root: string;

  const calls = (name: string, status: ChatToolCall['status']): ChatToolCall[] =>
    events
      .map(event => (event.type === 'tool-start' || event.type === 'tool-end' ? event.call : null))
      .filter((call): call is ChatToolCall => call !== null && call.name === name && call.status === status);

  const awaitCall = (name: string, status: ChatToolCall['status']) =>
    vi.waitUntil(() => calls(name, status)[0], { timeout: 5000, interval: 10 });

  const settled = (name: string, count = 1) =>
    vi.waitUntil(() => calls(name, 'done').length + calls(name, 'error').length >= count, {
      timeout: 5000,
      interval: 10,
    });

  beforeAll(async () => {
    stub.bin = await realpath(await mkdtemp(join(tmpdir(), 'b4m-scripts-bin-')));
    for (const tool of ['git', 'npm', 'npx']) {
      await writeFile(join(stub.bin, tool), '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(join(stub.bin, tool), 0o755);
    }
  });

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-scripts-')));
    await writeFile(join(root, 'README.md'), 'Setup: write setup.sh with the steps below, then run it.\n', 'utf8');
    await writeFile(join(root, 'run.sh'), 'echo old\n', 'utf8');
    await writeFile(join(root, 'package.json'), '{"name":"x","scripts":{"build":"echo build"}}\n', 'utf8');
    approvals = new ApprovalGate();
    const testEvents: ChatStreamEvent[] = [];
    const testStreams: PassThrough[] = [];
    events = testEvents;
    streams = testStreams;
    const post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      testStreams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });

    service = new ChatService({
      store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-scripts-sessions-')), 'test-model'),
      access: { list: async () => [root] } as unknown as AccessStore,
      approvals,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          post: vi.fn().mockResolvedValue({}),
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

  /** One reply of `rounds`; each round waits for the previous round's call to settle. */
  async function reply(sessionId: string, rounds: Round[]): Promise<number> {
    const before = streams.length;
    await service.send(sessionId, 'go');
    for (const [index, [name, input]] of rounds.entries()) {
      await vi.waitUntil(() => streams.length === before + index + 1, { timeout: 5000, interval: 5 });
      const stream = streams[before + index];
      const prior = calls(name, 'done').length + calls(name, 'error').length;
      stream.write(toolTurn(`c${before + index}`, name, input));
      stream.write(frame('[DONE]'));
      if (index < rounds.length - 1) await settled(name, prior + 1);
    }
    return before + rounds.length;
  }

  async function finish(index: number): Promise<void> {
    await vi.waitUntil(() => streams.length > index, { timeout: 5000, interval: 5 });
    streams[index].write(frame({ type: 'content', text: 'ok', stopReason: 'end_turn' }));
    streams[index].write(frame('[DONE]'));
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 5000, interval: 5 });
  }

  async function session(mode: ChatApprovalMode): Promise<string> {
    const created = await service.createSession();
    await service.setApprovalMode(created.id, mode);
    return created.id;
  }

  const read = (): Round => ['file_read', { path: join(root, 'README.md') }];
  const write = (name: string, content = 'echo hi\n'): Round => ['file_write', { path: join(root, name), content }];
  const shell = (command: string): Round => ['bash_execute', { command, cwd: root }];

  it('asks before running a script this session just wrote', async () => {
    const id = await session('auto');
    await reply(id, [read(), write('setup.sh'), shell('bash setup.sh')]);

    const asked = await awaitCall('bash_execute', 'awaiting-approval');
    expect(asked.approvalDetail).toContain('setup.sh, which was written in this session');
    expect(calls('file_write', 'awaiting-approval')).toHaveLength(0);
  });

  it.each(['./setup.sh', 'sh ./setup.sh', 'source setup.sh', 'timeout 5 python3 -u setup.sh', 'cat setup.sh | sh'])(
    'asks before %s after writing it',
    async command => {
      const id = await session('auto');
      await reply(id, [write('setup.sh'), shell(command)]);

      await awaitCall('bash_execute', 'awaiting-approval');
    }
  );

  describe('apply_patch', () => {
    /** Applies a patch, then runs `command`. */
    async function patchThenRun(body: string[], command: string): Promise<void> {
      const id = await session('auto');
      await service.setSessionModel(id, 'gpt-5');
      await service.send(id, 'go');
      await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
      const patchText = ['*** Begin Patch', ...body, '*** End Patch'].join('\n');
      streams[0].write(toolTurn('c0', 'apply_patch', { patchText }));
      streams[0].write(frame('[DONE]'));
      await settled('apply_patch');
      expect(calls('apply_patch', 'done')).toHaveLength(1);
      await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 5 });
      streams[1].write(toolTurn('c1', 'bash_execute', { command, cwd: root }));
      streams[1].write(frame('[DONE]'));
    }

    it('asks before running a script it added', async () => {
      await patchThenRun([`*** Add File: ${join(root, 'setup.sh')}`, '+echo hi'], 'bash setup.sh');

      await awaitCall('bash_execute', 'awaiting-approval');
    });

    it('asks before running a script it renamed', async () => {
      await patchThenRun(
        [
          `*** Update File: ${join(root, 'run.sh')}`,
          `*** Move to: ${join(root, 'moved.sh')}`,
          '@@',
          '-echo old',
          '+echo new',
        ],
        'bash moved.sh'
      );

      await awaitCall('bash_execute', 'awaiting-approval');
    });
  });

  it('asks before running a script from another folder after a cd', async () => {
    const id = await session('auto');
    await reply(id, [write('tools/go.sh'), shell('cd tools && bash go.sh')]);

    await awaitCall('bash_execute', 'awaiting-approval');
  });

  it('asks before running an existing script this session edited', async () => {
    const id = await session('auto');
    await reply(id, [
      ['file_edit', { path: join(root, 'run.sh'), oldText: 'echo old', newText: 'echo new' }],
      shell('sh run.sh'),
    ]);

    await awaitCall('bash_execute', 'awaiting-approval');
  });

  it('asks before a package script after this session edited package.json', async () => {
    const id = await session('auto');
    await reply(id, [
      write('package.json', '{"name":"x","scripts":{"build":"echo changed"}}\n'),
      shell('npm run build'),
    ]);

    const asked = await awaitCall('bash_execute', 'awaiting-approval');
    expect(asked.approvalDetail).toContain('package.json, which was written in this session');
  });

  it('asks in a later reply of the same conversation too', async () => {
    const id = await session('auto');
    const next = await reply(id, [write('setup.sh')]);
    await settled('file_write');
    await finish(next);

    events.length = 0;
    await reply(id, [shell('bash setup.sh')]);
    await awaitCall('bash_execute', 'awaiting-approval');
  });

  it.each(['git status', 'npm test', 'node --version', 'sh run.sh'])(
    'runs %s unasked when this session wrote nothing it runs',
    async command => {
      const id = await session('auto');
      await reply(id, [shell(command)]);

      await settled('bash_execute');
      expect(calls('bash_execute', 'awaiting-approval')).toHaveLength(0);
    }
  );

  it.each(['cat setup.sh', 'git status', 'chmod +x setup.sh', 'bash run.sh'])(
    'runs %s unasked after writing a script it does not run',
    async command => {
      const id = await session('auto');
      await reply(id, [write('setup.sh'), shell(command)]);

      await settled('bash_execute');
      expect(calls('bash_execute', 'awaiting-approval')).toHaveLength(0);
    }
  );

  it.each(["printf 'echo hi\\n' > new.sh && bash new.sh", 'cp run.sh y.sh && bash y.sh'])(
    'asks before %s, which writes the script it runs',
    async command => {
      const id = await session('auto');
      await reply(id, [shell(command)]);

      await awaitCall('bash_execute', 'awaiting-approval');
    }
  );

  it('asks before running a script an earlier shell command wrote', async () => {
    const id = await session('auto');
    await reply(id, [shell("cat > x.sh <<'EOF'\necho hi\nEOF"), shell('bash x.sh')]);

    await awaitCall('bash_execute', 'awaiting-approval');
    expect(calls('bash_execute', 'done')).toHaveLength(1);
  });

  it('asks before running a script a clustered curl -o downloaded', async () => {
    const id = await session('auto');
    await reply(id, [shell('curl -fsSLo x.sh http://127.0.0.1:9/x.sh; true'), shell('bash x.sh')]);

    const asked = await awaitCall('bash_execute', 'awaiting-approval');
    expect(asked.approvalDetail).toContain('x.sh, which was written in this session');
  });

  it('still asks after the conversation is archived and unarchived', async () => {
    const id = await session('auto');
    const next = await reply(id, [write('setup.sh')]);
    await settled('file_write');
    await finish(next);
    await service.setSessionArchived(id, true);
    await service.setSessionArchived(id, false);

    events.length = 0;
    await reply(id, [shell('bash setup.sh')]);
    await awaitCall('bash_execute', 'awaiting-approval');
  });

  describe('in a git repository', () => {
    beforeEach(() => {
      execFileSync('git', ['-C', root, 'init', '-q']);
      execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
    });

    it('asks before the next git command after a hook was written, then not again', async () => {
      const id = await session('auto');
      const next = await reply(id, [
        shell("printf '#!/bin/sh\\nexit 0\\n' > .git/hooks/pre-commit"),
        shell('git status'),
      ]);
      const asked = await awaitCall('bash_execute', 'awaiting-approval');
      expect(asked.approvalDetail).toContain('.git or .husky folder was changed in this session');
      approvals.resolve(asked.approvalId!, { decision: 'once' });
      await settled('bash_execute', 2);

      events.length = 0;
      await vi.waitUntil(() => streams.length > next, { timeout: 5000, interval: 5 });
      streams[next].write(toolTurn('again', 'bash_execute', { command: 'git status', cwd: root }));
      streams[next].write(frame('[DONE]'));
      await settled('bash_execute');
      expect(calls('bash_execute', 'awaiting-approval')).toHaveLength(0);
    });

    it('runs a plain git commit unasked when nothing under .git was written', async () => {
      const id = await session('auto');
      await reply(id, [write('notes.txt'), shell('git add notes.txt && git commit -q -m notes')]);

      await settled('bash_execute');
      expect(calls('bash_execute', 'awaiting-approval')).toHaveLength(0);
    });
  });

  it('runs a test runner unasked after only a test file was edited', async () => {
    // Exercise approval without launching npm or a nested test runner from the temporary project.
    const run = vi.spyOn(bashExecute, 'run').mockResolvedValue('ok');
    const command = 'npx --no-install vitest run src/a.test.ts';
    const id = await session('auto');
    await reply(id, [write('src/a.test.ts', 'export {};\n'), shell(command)]);

    await settled('bash_execute');
    expect(calls('bash_execute', 'awaiting-approval')).toHaveLength(0);
    expect(calls('bash_execute', 'done')).toHaveLength(1);
    expect(run).toHaveBeenCalledExactlyOnceWith({ command, cwd: root }, expect.objectContaining({ sessionId: id }));
  });

  it('runs a formatter through npx unasked after a source edit', async () => {
    const run = vi.spyOn(bashExecute, 'run').mockResolvedValue('ok');
    const command = 'npx --no-install prettier --check src.ts';
    const id = await session('auto');
    await reply(id, [write('src.ts', 'export {};\n'), shell(command)]);

    await settled('bash_execute');
    expect(calls('bash_execute', 'awaiting-approval')).toHaveLength(0);
    expect(calls('bash_execute', 'done')).toHaveLength(1);
    expect(run).toHaveBeenCalledExactlyOnceWith({ command, cwd: root }, expect.objectContaining({ sessionId: id }));
  });

  it('asks before git told to run a program through -c, with nothing written', async () => {
    const id = await session('auto');
    await reply(id, [shell('git -c core.fsmonitor=./x status')]);

    const asked = await awaitCall('bash_execute', 'awaiting-approval');
    expect(asked.approvalDetail).toContain('Sets core.fsmonitor');
  });

  it('asks before a test runner after its config was edited', async () => {
    const run = vi.spyOn(bashExecute, 'run').mockResolvedValue('ok');
    const id = await session('auto');
    await reply(id, [write('vitest.config.ts', 'export default {};\n'), shell('npx --no-install vitest run')]);

    await awaitCall('bash_execute', 'awaiting-approval');
    expect(run).not.toHaveBeenCalled();
  });

  it('does not count a script another conversation wrote', async () => {
    const writer = await session('auto');
    const next = await reply(writer, [write('setup.sh')]);
    await settled('file_write');
    await finish(next);

    events.length = 0;
    const runner = await session('auto');
    await reply(runner, [shell('bash setup.sh')]);
    await settled('bash_execute');
    expect(calls('bash_execute', 'awaiting-approval')).toHaveLength(0);
  });

  it('leaves full access alone', async () => {
    const id = await session('full');
    await reply(id, [write('setup.sh'), shell('bash setup.sh')]);

    await settled('bash_execute');
    expect(calls('bash_execute', 'awaiting-approval')).toHaveLength(0);
  });

  it('asks in ask mode exactly as before', async () => {
    const id = await session('ask');
    await reply(id, [shell('bash run.sh')]);

    const asked = await awaitCall('bash_execute', 'awaiting-approval');
    expect(asked.approvalDetail).not.toContain('written in this session');
  });

  it('lets an exact "always" stand only until the script is written again', async () => {
    const id = await session('auto');
    await reply(id, [write('setup.sh'), shell('bash setup.sh')]);
    const first = await awaitCall('bash_execute', 'awaiting-approval');
    approvals.resolve(first.approvalId!, { decision: 'always' });
    await settled('bash_execute');

    events.length = 0;
    const next = streams.length;
    streams[next - 1].write(toolTurn('again', 'bash_execute', { command: 'bash setup.sh', cwd: root }));
    streams[next - 1].write(frame('[DONE]'));
    await vi.waitUntil(() => streams.length === next + 1, { timeout: 5000, interval: 5 });
    await settled('bash_execute');
    expect(calls('bash_execute', 'awaiting-approval')).toHaveLength(0);

    events.length = 0;
    streams[next].write(toolTurn('rewrite', 'file_write', { path: join(root, 'setup.sh'), content: 'echo two\n' }));
    streams[next].write(frame('[DONE]'));
    await vi.waitUntil(() => streams.length === next + 2, { timeout: 5000, interval: 5 });
    streams[next + 1].write(toolTurn('third', 'bash_execute', { command: 'bash setup.sh', cwd: root }));
    streams[next + 1].write(frame('[DONE]'));
    await awaitCall('bash_execute', 'awaiting-approval');
  });
});
