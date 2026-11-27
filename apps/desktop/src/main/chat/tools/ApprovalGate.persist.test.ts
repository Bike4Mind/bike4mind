import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatApprovalAnswer } from '@shared/chat';
import { SessionStore } from '../SessionStore';
import { ApprovalGate, type ApprovalRequestOptions } from './ApprovalGate';
import type { ChatAllowanceStore, StoredChatAllowances } from './chatAllowances';
import { commandShape } from './commandShape';
import type { ApprovalAlways } from './types';

/** A store kept in memory, standing in for SessionStore's `.chat-allowances` folder. */
function memoryStore(): ChatAllowanceStore & { records: Map<string, unknown> } {
  const records = new Map<string, unknown>();
  return {
    records,
    loadChatAllowances: async id => (records.has(id) ? structuredClone(records.get(id)) : null),
    saveChatAllowances: async (id, allowances: StoredChatAllowances) => {
      records.set(id, structuredClone(allowances));
    },
    deleteChatAllowances: async id => {
      records.delete(id);
    },
  };
}

async function answer(
  gate: ApprovalGate,
  sessionId: string,
  key: string,
  given: ChatApprovalAnswer,
  options: ApprovalRequestOptions = {}
): Promise<void> {
  const controller = new AbortController();
  let approvalId = '';
  const settled = gate.request(sessionId, key, controller.signal, id => (approvalId = id), options);
  gate.resolve(approvalId, given);
  await settled;
  await gate.flush(sessionId);
}

const shell = (text: string, extra: Partial<ApprovalAlways> = {}): ApprovalAlways => ({
  namespace: 'bash_execute',
  commands: [{ text, pattern: `${text.split(' ')[0]} *`, coverable: true }],
  directories: [],
  ...extra,
});

/** A fresh gate over the same store: what the next launch of the app sees. */
async function relaunch(store: ChatAllowanceStore, sessionId: string, warn = vi.fn()): Promise<ApprovalGate> {
  const gate = new ApprovalGate(undefined, store, warn);
  await gate.ready(sessionId);
  return gate;
}

describe('ApprovalGate persisted chat allowances', () => {
  it('keeps "Allow in this chat" across a reload', async () => {
    const store = memoryStore();
    const gate = new ApprovalGate(undefined, store);
    await answer(gate, 's', 'web_fetch:https://a', { decision: 'always' });
    await answer(gate, 's', 'pick', { decision: 'always', optionId: 'local', value: 'v' });
    await answer(
      gate,
      's',
      'shell-key',
      { decision: 'always' },
      { always: shell('git commit -m x', { directories: ['/outside'] }) }
    );

    const next = await relaunch(store, 's');
    expect(next.isStanding('s', 'web_fetch:https://a')).toEqual({});
    expect(next.isStanding('s', 'pick', ['local'])).toEqual({ optionId: 'local', value: 'v' });
    expect(next.coversCommands('s', shell('git commit -m other'))).toBe(true);
    expect(next.uncoveredDirectories('s', ['/outside/sub'])).toEqual([]);
  });

  it('never carries an allowance to another conversation, and a new one starts with none', async () => {
    const store = memoryStore();
    const gate = new ApprovalGate(undefined, store);
    await answer(gate, 's', 'web_fetch:https://a', { decision: 'always' }, { always: shell('git commit -m x') });

    const next = await relaunch(store, 'other');
    expect(next.isStanding('other', 'web_fetch:https://a')).toBeNull();
    expect(next.coversCommands('other', shell('git commit -m x'))).toBe(false);
    expect(store.records.has('other')).toBe(false);
  });

  it('drops the stored record when the conversation is deleted', async () => {
    const store = memoryStore();
    const gate = new ApprovalGate(undefined, store);
    await answer(gate, 's', 'web_fetch:https://a', { decision: 'always' });
    expect(store.records.has('s')).toBe(true);

    await gate.forgetSession('s');
    expect(store.records.has('s')).toBe(false);
    expect((await relaunch(store, 's')).isStanding('s', 'web_fetch:https://a')).toBeNull();
  });

  it('ignores a malformed record with a warning and allows nothing from it', async () => {
    const store = memoryStore();
    store.records.set('s', {
      version: 1,
      answers: [{ key: 'web_fetch:https://a' }],
      // A relative directory would cover every path under the current folder.
      shell: [{ key: 'k', patterns: [], directories: ['relative'], shapes: [] }],
    });
    store.records.set('t', { version: 2, answers: [], shell: [] });
    store.records.set('u', 'not an object');

    for (const id of ['s', 't', 'u']) {
      const warn = vi.fn();
      const next = await relaunch(store, id, warn);
      expect(next.isStanding(id, 'web_fetch:https://a')).toBeNull();
      expect(next.uncoveredDirectories(id, ['/x'])).toEqual(['/x']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed'));
    }
  });

  it('allows nothing and does not throw when the store cannot be read', async () => {
    const store = memoryStore();
    store.loadChatAllowances = async () => {
      throw new Error('disk on fire');
    };
    const warn = vi.fn();
    const next = await relaunch(store, 's', warn);
    expect(next.isStanding('s', 'k')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk on fire'));
  });

  it('records nothing for an answer the gate does not remember', async () => {
    const store = memoryStore();
    const gate = new ApprovalGate(undefined, store);
    await answer(gate, 's', 'rm', { decision: 'always' }, { remember: false });
    await answer(gate, 's', 'ls', { decision: 'once' });
    expect(store.records.has('s')).toBe(false);
  });

  it('applies a revoke given before the stored record is read', async () => {
    const store = memoryStore();
    const gate = new ApprovalGate(undefined, store);
    await answer(gate, 's', 'web_fetch:https://a', { decision: 'always' });
    await answer(gate, 's', 'web_fetch:https://b', { decision: 'always' });

    const next = new ApprovalGate(undefined, store);
    expect(next.revoke('s', 'web_fetch:https://a')).toBe(true);
    await next.ready('s');
    await next.flush('s');
    expect(next.isStanding('s', 'web_fetch:https://a')).toBeNull();
    expect(next.isStanding('s', 'web_fetch:https://b')).toEqual({});
    expect((await relaunch(store, 's')).isStanding('s', 'web_fetch:https://a')).toBeNull();
  });

  it('removes the record once its last allowance is revoked', async () => {
    const store = memoryStore();
    const gate = new ApprovalGate(undefined, store);
    await answer(gate, 's', 'web_fetch:https://a', { decision: 'always' });
    expect(gate.revoke('s', 'web_fetch:https://a')).toBe(true);
    await gate.flush('s');
    expect(store.records.has('s')).toBe(false);
  });

  it('lets a spawned conversation use what its parent allowed in an earlier launch', async () => {
    const store = memoryStore();
    const gate = new ApprovalGate(undefined, store);
    await answer(gate, 'parent', 'k', { decision: 'always' }, { always: shell('git commit -m x') });

    const next = new ApprovalGate(undefined, store);
    next.setParent('child', 'parent');
    await next.ready('child');
    expect(next.coversCommands('child', shell('git commit -m y'))).toBe(true);
  });

  describe('command shapes', () => {
    const shaped = (command: string, cwd = '/project'): ApprovalAlways =>
      shell(command, { shape: `${cwd}\x00${commandShape(command) ?? ''}` });
    const covers = (gate: ApprovalGate, sessionId: string, command: string, cwd?: string) => {
      const always = shaped(command, cwd);
      return gate.coversShape(sessionId, always.namespace, always.shape ?? '');
    };

    it('covers the same command with a different variable, after a reload too', async () => {
      const store = memoryStore();
      const gate = new ApprovalGate(undefined, store);
      await answer(gate, 's', 'k', { decision: 'always' }, { always: shaped('git push origin "$BRANCH"') });

      expect(covers(gate, 's', 'git push origin "$OTHER"')).toBe(true);
      const next = await relaunch(store, 's');
      expect(covers(next, 's', 'git push origin "${OTHER}"')).toBe(true);
    });

    it('does not cover a change in structure, another folder, tool or conversation', async () => {
      const gate = new ApprovalGate(undefined, memoryStore());
      await answer(gate, 's', 'k', { decision: 'always' }, { always: shaped('git push origin "$BRANCH"') });

      expect(covers(gate, 's', 'git push origin "$BRANCH" && rm -rf ~')).toBe(false);
      expect(covers(gate, 's', 'git push --force origin "$BRANCH"')).toBe(false);
      expect(covers(gate, 's', 'git push origin "$BRANCH" > out')).toBe(false);
      expect(covers(gate, 's', 'git push origin "$BRANCH"', '/elsewhere')).toBe(false);
      expect(covers(gate, 'other', 'git push origin "$BRANCH"')).toBe(false);
      expect(gate.coversShape('s', 'bash_background', shaped('git push origin "$BRANCH"').shape ?? '')).toBe(false);
    });

    it('records no shape from an answer the gate does not remember', async () => {
      const gate = new ApprovalGate(undefined, memoryStore());
      await answer(gate, 's', 'k', { decision: 'always' }, { always: shaped('git push origin "$X"'), remember: false });
      expect(covers(gate, 's', 'git push origin "$X"')).toBe(false);
    });
  });
});

async function findFolder(root: string, name: string): Promise<string> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const found = entries.find(entry => entry.isDirectory() && entry.name === name);
  if (!found) throw new Error(`no ${name} under ${root}`);
  return join(found.parentPath, found.name);
}

describe('SessionStore chat allowance files', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'b4m-allowances-'));
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it('reads back what it wrote, ignores a corrupt file and deletes with the conversation', async () => {
    const id = randomUUID();
    const store = new SessionStore(directory, 'test-model');
    const gate = new ApprovalGate(undefined, store);
    await answer(gate, id, 'web_fetch:https://a', { decision: 'always' });
    expect((await relaunch(store, id)).isStanding(id, 'web_fetch:https://a')).toEqual({});

    const folder = await findFolder(directory, '.chat-allowances');
    const [file] = await readdir(folder);
    await writeFile(join(folder, file ?? ''), '{ not json', 'utf8');
    const warn = vi.fn();
    expect((await relaunch(store, id, warn)).isStanding(id, 'web_fetch:https://a')).toBeNull();
    expect(warn).toHaveBeenCalled();

    await gate.forgetSession(id);
    expect(await readdir(folder)).toEqual([]);
  });
});
