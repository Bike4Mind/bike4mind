import { mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatApprovalMode, ChatStreamEvent, ChatToolCall } from '@shared/chat';
import type { PermissionList } from '@shared/permissions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import { PermissionRuleSet, compileRule, parseRule, type CompiledRule } from './permissions/rules';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';
import { toolsForRequest } from './tools/registry';
import { bashExecute } from './tools/shellTools';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function ruleSet(lists: Partial<Record<PermissionList, string[]>>): PermissionRuleSet {
  const compiled: CompiledRule[] = [];
  for (const [list, texts] of Object.entries(lists) as [PermissionList, string[]][]) {
    for (const text of texts) {
      const parsed = parseRule(text, { native: true });
      if (!parsed.ok) throw new Error(parsed.reason);
      const rule = compileRule(
        parsed.rule,
        list,
        { id: 'cc-user', label: 'Claude Code user', path: '/x/settings.json' },
        {
          home: '/nowhere',
          root: null,
          cwd: null,
        }
      );
      if (rule) compiled.push(rule);
    }
  }
  return new PermissionRuleSet(compiled);
}

/** The approval path with standing rules: deny refuses, ask asks, allow runs, and the floors hold. */
describe('ChatService permission rules', () => {
  let service: ChatService;
  let approvals: ApprovalGate;
  let events: ChatStreamEvent[];
  let streams: PassThrough[];
  let root: string;
  let rules: PermissionRuleSet;
  let rulesFailure: Error | undefined;
  let warn: ReturnType<typeof vi.fn<(message: string) => void>>;
  let rememberAllows: ReturnType<typeof vi.fn<(rules: readonly string[]) => Promise<void>>>;

  const calls = (name: string, status: ChatToolCall['status']): ChatToolCall[] =>
    events
      .map(event => (event.type === 'tool-start' || event.type === 'tool-end' ? event.call : null))
      .filter((call): call is ChatToolCall => call !== null && call.name === name && call.status === status);

  const awaitCall = (name: string, status: ChatToolCall['status']) =>
    vi.waitUntil(() => calls(name, status)[0], { timeout: 5000, interval: 10 });

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-rules-')));
    await writeFile(join(root, 'notes.txt'), 'hello\n', 'utf8');
    approvals = new ApprovalGate();
    rules = ruleSet({});
    rulesFailure = undefined;
    warn = vi.fn<(message: string) => void>();
    rememberAllows = vi.fn<(rules: readonly string[]) => Promise<void>>().mockResolvedValue(undefined);
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
      store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-rules-sessions-')), 'test-model'),
      access: { list: async () => [root] } as unknown as AccessStore,
      approvals,
      permissions: {
        rulesFor: async () => {
          if (rulesFailure) throw rulesFailure;
          return rules;
        },
        rememberAllows,
        invalidate: vi.fn(),
      },
      logger: { debug: vi.fn(), warn },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          post: vi.fn().mockResolvedValue({ result: 'page' }),
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

  async function run(mode: ChatApprovalMode, name: string, input: Record<string, unknown>): Promise<string> {
    const created = await service.createSession();
    await service.setApprovalMode(created.id, mode);
    const before = streams.length;
    await service.send(created.id, 'go');
    await vi.waitUntil(() => streams.length === before + 1, { timeout: 5000, interval: 5 });
    streams[before].write(frame({ type: 'tool_use', tools: [{ id: 'c1', name, arguments: JSON.stringify(input) }] }));
    streams[before].write(frame('[DONE]'));
    return created.id;
  }

  it.each(['ask', 'auto', 'full'] as const)('refuses tool execution when rules fail to load in %s', async mode => {
    rulesFailure = new Error('permission file unreadable');
    await run(mode, 'file_read', { path: join(root, 'notes.txt') });
    const refused = await awaitCall('file_read', 'denied');
    expect(refused.error).toContain('Cannot load permission rules');
    expect(refused.error).toContain('permission file unreadable');
    expect(calls('file_read', 'done')).toHaveLength(0);
  });

  it.each(['request_directory', 'mcp_add_server', 'ask_user'])(
    'honors a deny rule before showing the interactive %s card',
    async name => {
      rules = ruleSet({ deny: [name] });
      await run('full', name, {});

      const refused = await awaitCall(name, 'denied');
      expect(refused.error).toContain(`deny rule ${name}`);
      expect(calls(name, 'awaiting-approval')).toHaveLength(0);
    }
  );

  it('never auto-answers an interactive question because of an allow rule', async () => {
    rules = ruleSet({ allow: ['ask_user'] });
    await run('full', 'ask_user', {
      questions: [
        {
          id: 'choice',
          question: 'Which one?',
          options: [
            { label: 'One', description: 'First' },
            { label: 'Two', description: 'Second' },
          ],
        },
      ],
    });
    await awaitCall('ask_user', 'awaiting-approval');
    expect(calls('ask_user', 'done')).toHaveLength(0);
  });

  it('refuses a denied command in every mode, naming the rule and its source', async () => {
    rules = ruleSet({ deny: ['Bash(rm:*)'], allow: ['Bash(echo:*)'] });
    await run('full', 'bash_execute', { command: 'echo hi && rm notes.txt', cwd: root });

    const refused = await awaitCall('bash_execute', 'denied');
    expect(refused.error).toContain('Bash(rm:*) in Claude Code user (/x/settings.json)');
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('hello\n');
  });

  it('refuses a denied read that no mode would have asked about', async () => {
    rules = ruleSet({ deny: [`Read(/${root}/**)`] });
    await run('auto', 'file_read', { path: join(root, 'notes.txt') });

    const refused = await awaitCall('file_read', 'denied');
    expect(refused.error).toContain(`Read(/${root}/**)`);
  });

  it.each(['grep_search', 'glob_files'])('refuses %s rooted above a denied descendant', async name => {
    rules = ruleSet({ deny: [`Read(/${root}/notes.txt)`] });
    await run('full', name, { path: root, pattern: '*' });
    const refused = await awaitCall(name, 'denied');
    expect(refused.error).toContain(`Read(/${root}/notes.txt)`);
    expect(calls(name, 'done')).toHaveLength(0);
  });

  it('refuses a read through a symlink to a denied file inside the shared root', async () => {
    await symlink(join(root, 'notes.txt'), join(root, 'alias.txt'));
    rules = ruleSet({ deny: [`Read(/${root}/notes.txt)`] });
    await run('full', 'file_read', { path: join(root, 'alias.txt') });
    const refused = await awaitCall('file_read', 'denied');
    expect(refused.error).toContain(`Read(/${root}/notes.txt)`);
    expect(calls('file_read', 'done')).toHaveLength(0);
  });

  it('asks on an ask rule even in Approve for me and full access, and says why', async () => {
    rules = ruleSet({ ask: ['Bash(git push:*)'], allow: ['Bash(git:*)'] });
    await run('full', 'bash_execute', { command: 'git push', cwd: root });

    const asked = await awaitCall('bash_execute', 'awaiting-approval');
    expect(asked.approvalDetail).toContain('Asked because of the rule Bash(git push:*)');
    expect(asked.approvalRules).toBeUndefined();
  });

  it('asks on an ask rule for a tool that never asks', async () => {
    rules = ruleSet({ ask: ['WebSearch'] });
    await run('full', 'web_search', { query: 'x' });

    const asked = await awaitCall('web_search', 'awaiting-approval');
    expect(asked.approvalDetail).toContain('Asked because of the rule WebSearch');
  });

  it('runs an allowed command unasked in Ask', async () => {
    rules = ruleSet({ allow: ['Bash(wc:*)', 'Bash(cat:*)'] });
    await run('ask', 'bash_execute', { command: 'wc -l notes.txt | cat', cwd: root });

    await awaitCall('bash_execute', 'running');
    expect(calls('bash_execute', 'awaiting-approval')).toHaveLength(0);
  });

  it('asks in Ask when only part of a compound command is allowed', async () => {
    rules = ruleSet({ allow: ['Bash(wc:*)'] });
    await run('ask', 'bash_execute', { command: 'wc -l notes.txt && touch x', cwd: root });

    await awaitCall('bash_execute', 'awaiting-approval');
  });

  it('does not let a broad prefix cover an inline script', async () => {
    rules = ruleSet({ allow: ['Bash(node:*)'] });
    await run('ask', 'bash_execute', { command: `node -e 'console.log(1)'`, cwd: root });

    const asked = await awaitCall('bash_execute', 'awaiting-approval');
    expect(asked.approvalRules).toBeUndefined();
  });

  it('lets a rule naming the inline form cover it', async () => {
    rules = ruleSet({ allow: ["Bash(node -e ' *)"] });
    await run('ask', 'bash_execute', { command: `node -e 'console.log(1)'`, cwd: root });

    await awaitCall('bash_execute', 'running');
    expect(calls('bash_execute', 'awaiting-approval')).toHaveLength(0);
  });

  // Not a temp folder: the shell scan counts those as shared already.
  it('asks for a folder outside the shared ones that no Read or Edit rule covers', async () => {
    rules = ruleSet({ allow: ['Bash(ls:*)'] });
    await run('ask', 'bash_execute', { command: 'ls /usr/share', cwd: root });
    await awaitCall('bash_execute', 'awaiting-approval');
  });

  it('runs a command in an outside folder that a Read rule covers', async () => {
    rules = ruleSet({ allow: ['Bash(ls:*)', 'Read(//usr/**)'] });
    await run('ask', 'bash_execute', { command: 'ls /usr/share', cwd: root });
    await awaitCall('bash_execute', 'running');
    expect(calls('bash_execute', 'awaiting-approval')).toHaveLength(0);
  });

  it('saves the derived rule when the card is answered "Always, in every session"', async () => {
    await run('ask', 'bash_execute', { command: 'git status --short', cwd: root });
    const asked = await awaitCall('bash_execute', 'awaiting-approval');
    expect(asked.approvalRules).toEqual(['Bash(git status:*)']);

    approvals.resolve(asked.approvalId!, { decision: 'always', everywhere: true });
    await awaitCall('bash_execute', 'running');
    expect(rememberAllows).toHaveBeenCalledWith(['Bash(git status:*)']);
  });

  it('shows a failed every-session save instead of silently claiming persistence', async () => {
    rememberAllows.mockRejectedValueOnce(new Error('disk full'));
    // The notice lands on the settled call, which must not wait on the host's own git.
    vi.spyOn(bashExecute, 'run').mockResolvedValue('git status completed');
    await run('ask', 'bash_execute', { command: 'git status', cwd: root });
    const asked = await awaitCall('bash_execute', 'awaiting-approval');
    approvals.resolve(asked.approvalId!, { decision: 'always', everywhere: true });
    const settled = await vi.waitUntil(() => calls('bash_execute', 'done')[0] ?? calls('bash_execute', 'error')[0], {
      timeout: 5000,
      interval: 10,
    });
    expect(rememberAllows).toHaveBeenCalledTimes(1);
    expect(settled).toMatchObject({ notice: { kind: 'permissions-save-failed' } });
    expect(settled.notice?.text).toContain('disk full');
    expect(settled.notice?.text).toContain('Settings > Permissions');
  });

  it('saves nothing on a plain "Always allow"', async () => {
    await run('ask', 'bash_execute', { command: 'git status', cwd: root });
    const asked = await awaitCall('bash_execute', 'awaiting-approval');
    approvals.resolve(asked.approvalId!, { decision: 'always' });
    await awaitCall('bash_execute', 'running');
    expect(rememberAllows).not.toHaveBeenCalled();
  });

  it('keeps the card pending and logs when its rules cannot be rechecked', async () => {
    await run('ask', 'web_fetch', { url: 'https://example.com/' });
    const asked = await awaitCall('web_fetch', 'awaiting-approval');
    rulesFailure = new Error('permission file unreadable');
    await approvals.settleCovered();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not recheck web_fetch'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('permission file unreadable'));
    expect(calls('web_fetch', 'running')).toHaveLength(0);
    approvals.resolve(asked.approvalId!, { decision: 'deny' });
    await awaitCall('web_fetch', 'denied');
  });

  it('rechecks symlink targets when the first rules arrive while a card waits', async () => {
    const alias = join(root, 'alias.txt');
    await symlink(join(root, 'notes.txt'), alias);
    await run('ask', 'file_write', { path: alias, content: 'changed\n' });
    await awaitCall('file_write', 'awaiting-approval');

    rules = ruleSet({ allow: [`Edit(/${alias})`], deny: [`Edit(/${root}/notes.txt)`] });
    await approvals.settleCovered();

    await awaitCall('file_write', 'denied');
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('hello\n');
    expect(calls('file_write', 'done')).toHaveLength(0);
  });

  it('applies a new deny even when an ask rule originally raised the card', async () => {
    rules = ruleSet({ ask: ['WebFetch'] });
    await run('full', 'web_fetch', { url: 'https://example.com/' });
    await awaitCall('web_fetch', 'awaiting-approval');

    rules = ruleSet({ deny: ['WebFetch'] });
    await approvals.settleCovered();

    await awaitCall('web_fetch', 'denied');
    expect(calls('web_fetch', 'done')).toHaveLength(0);
  });

  it('derives the every-site WebFetch rule for a fetch', async () => {
    await run('ask', 'web_fetch', { url: 'https://docs.example.com/a' });
    const asked = await awaitCall('web_fetch', 'awaiting-approval');
    expect(asked.approvalRules).toEqual(['WebFetch']);
  });
});

describe('no model write to permission rules', () => {
  it('offers the model no tool that names permissions or settings', () => {
    const names = toolsForRequest({
      roots: ['/work'],
      media: true,
      host: true,
      explore: true,
      browser: true,
      memory: true,
      skills: true,
      web: true,
      ask: true,
      mcpServers: true,
    }).map(tool => tool.toolSchema.name);
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) expect(name).not.toMatch(/permission|rule|setting/i);
  });

  it('leaves the rule store out of what a tool is given', async () => {
    const source = await readFile(join(__dirname, 'tools', 'types.ts'), 'utf8');
    const context = source.slice(source.indexOf('export interface ToolContext'));
    expect(context.slice(0, context.indexOf('\n}\n'))).not.toMatch(/permission/i);
  });
});
