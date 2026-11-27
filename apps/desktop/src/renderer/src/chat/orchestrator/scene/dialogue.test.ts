import { describe, expect, it } from 'vitest';
import type { ChatDiff, ChatToolCall } from '@shared/chat';
import type { PendingDecision } from '@shared/pendingDecisions';
import { commandApprovalOf, decisionKey, dialogueKeyAction, dialogueQueue, queueIndex, reachedEnd } from './dialogue';

const call = (extra: Partial<ChatToolCall> = {}): ChatToolCall => ({
  id: 'c1',
  name: 'bash_execute',
  input: { command: 'pnpm test' },
  status: 'awaiting-approval',
  approvalId: 'ap1',
  ...extra,
});

const approval = (sessionId: string, id: string, extra: Partial<ChatToolCall> = {}): PendingDecision => ({
  kind: 'approval',
  sessionId,
  decisionId: `approval:${id}`,
  approvalId: id,
  call: call({ approvalId: id, ...extra }),
  collectsSecrets: false,
});

const failed = (sessionId: string, id: string): PendingDecision => ({
  kind: 'error',
  sessionId,
  decisionId: `error:${id}`,
  messageId: id,
  error: 'boom',
});

const keys = { shiftKey: false, metaKey: false, ctrlKey: false, altKey: false };

describe('dialogueQueue', () => {
  it('puts approvals first and keeps roster order within a kind', () => {
    const byId = new Map<string, PendingDecision[]>([
      ['a', [failed('a', 'e1')]],
      ['b', [approval('b', 'p1')]],
      ['c', [approval('c', 'p2'), failed('c', 'e2')]],
    ]);
    expect(dialogueQueue(byId).map(decisionKey)).toEqual([
      'b:approval:p1',
      'c:approval:p2',
      'a:error:e1',
      'c:error:e2',
    ]);
  });
});

describe('queueIndex', () => {
  const queue = [approval('a', 'p1'), approval('b', 'p2'), failed('b', 'e1')];

  it('finds a decision by key, then by session id, else the head', () => {
    expect(queueIndex(queue, undefined)).toBe(0);
    expect(queueIndex(queue, 'b:error:e1')).toBe(2);
    expect(queueIndex(queue, 'b')).toBe(1);
    expect(queueIndex(queue, 'gone:approval:x')).toBe(0);
  });
});

describe('commandApprovalOf', () => {
  it('draws a plain shell approval with its full command', () => {
    const command = commandApprovalOf(
      approval('a', 'p1', { approvalDetail: 'rm -rf build\nls', approvalAlways: 'rm' })
    );
    expect(command).toMatchObject({
      approvalId: 'p1',
      ask: 'wants to run a command',
      text: 'rm -rf build\nls',
      allowInChat: true,
      scope: 'rm',
      moreInDetails: false,
    });
  });

  it('drops Allow in this chat for a once-only approval', () => {
    expect(commandApprovalOf(approval('a', 'p1', { approvalOnceOnly: true }))).toMatchObject({
      allowInChat: false,
      scope: undefined,
    });
  });

  it('flags the choices only the full card offers', () => {
    expect(commandApprovalOf(approval('a', 'p1', { approvalRules: ['Bash(pnpm test)'] }))?.moreInDetails).toBe(true);
  });

  it.each<[string, Partial<ChatToolCall>]>([
    ['an irreversible call', { approvalIrreversible: true }],
    ['a diff', { approvalDiff: {} as ChatDiff }],
    ['a question form', { name: 'ask_user' }],
  ])('leaves %s to the full card', (_label, extra) => {
    expect(commandApprovalOf(approval('a', 'p1', extra))).toBeUndefined();
  });

  it('leaves secrets and non-approvals to the full card', () => {
    expect(commandApprovalOf({ ...approval('a', 'p1'), collectsSecrets: true } as PendingDecision)).toBeUndefined();
    expect(commandApprovalOf(failed('a', 'e1'))).toBeUndefined();
  });

  it('caps a long description to one line', () => {
    const description = commandApprovalOf(
      approval('a', 'p1', { approvalDescription: `${'word '.repeat(60)}\nend` })
    )?.description;
    expect(description?.length).toBeLessThanOrEqual(140);
    expect(description?.endsWith('...')).toBe(true);
    expect(description).not.toContain('\n');
  });
});

describe('reachedEnd', () => {
  it('counts a box that fits or is scrolled to within the slack', () => {
    expect(reachedEnd({ scrollTop: 0, clientHeight: 100, scrollHeight: 100 })).toBe(true);
    expect(reachedEnd({ scrollTop: 99, clientHeight: 100, scrollHeight: 200 })).toBe(true);
    expect(reachedEnd({ scrollTop: 50, clientHeight: 100, scrollHeight: 200 })).toBe(false);
  });
});

describe('dialogueKeyAction', () => {
  it('maps the box keys case-insensitively', () => {
    expect(dialogueKeyAction({ ...keys, key: 'a' })).toBe('once');
    expect(dialogueKeyAction({ ...keys, key: 'C' })).toBe('chat');
    expect(dialogueKeyAction({ ...keys, key: 'd' })).toBe('deny');
    expect(dialogueKeyAction({ ...keys, key: 'o' })).toBe('open');
    expect(dialogueKeyAction({ ...keys, key: 'e' })).toBe('expand');
    expect(dialogueKeyAction({ ...keys, key: 'ArrowRight' })).toBe('next');
    expect(dialogueKeyAction({ ...keys, key: 'ArrowLeft' })).toBe('previous');
    expect(dialogueKeyAction({ ...keys, key: 'Escape' })).toBe('minimize');
    expect(dialogueKeyAction({ ...keys, key: 'Tab' })).toBeUndefined();
  });

  it('leaves modified keys to the app', () => {
    expect(dialogueKeyAction({ ...keys, key: 'c', metaKey: true })).toBeUndefined();
    expect(dialogueKeyAction({ ...keys, key: 'a', shiftKey: true })).toBeUndefined();
  });
});
