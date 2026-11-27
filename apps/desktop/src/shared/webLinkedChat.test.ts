import { describe, expect, it } from 'vitest';
import { OPTIMISTIC_ID_PREFIX, type ChatSession } from './chat';
import {
  isLinkedChatBusy,
  isLinkedReplyRunning,
  isLinkedWebSend,
  isLinkedWebSession,
  LINKED_RUNNING_LEASE_MS,
} from './webLinkedChat';

const webChat = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: 'bw-scope-nb1',
  title: 'Notebook',
  model: 'claude-sonnet',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  mode: 'chat',
  approvalMode: 'ask',
  reasoningEffort: 'default',
  importOrigin: { kind: 'b4m-web', sourceId: 'nb1', importedAt: '', sourceUpdatedAt: '' },
  messages: [{ id: 'bw-q1-p', role: 'user', content: 'hi', createdAt: '2026-01-01T00:00:00.000Z' }],
  ...overrides,
});

const plain = { attachments: 0 };

describe('isLinkedWebSend', () => {
  it('sends a plain message in a synced web chat to the web session', () => {
    expect(isLinkedWebSend(webChat(), plain)).toBe(true);
  });

  it.each([
    [
      'Claude Code imports',
      { importOrigin: { kind: 'claude-code' as const, sourceId: 's', importedAt: '', sourceUpdatedAt: '' } },
    ],
    [
      'Claude chat imports',
      { importOrigin: { kind: 'claude-chat' as const, sourceId: 's', importedAt: '', sourceUpdatedAt: '' } },
    ],
    ['code-mode sessions', { mode: 'code' as const }],
    [
      'web chats already continued here',
      {
        importOrigin: { kind: 'b4m-web' as const, sourceId: 'nb1', importedAt: '', sourceUpdatedAt: '', forkedAt: 'x' },
      },
    ],
    [
      'web chats holding a locally written message',
      { messages: [{ id: 'local-1', role: 'user' as const, content: 'hi', createdAt: '' }] },
    ],
    ['chats with folders shared to local tools', { grantedDirectories: ['/tmp/x'] }],
    ['orchestrated chats', { orchestrate: true }],
    ['sessions that were never imported', { importOrigin: undefined }],
    ['chats on a model served from this machine', { model: 'local:ollama:llama3' }],
    ['chats with no model picked', { model: '' }],
  ])('keeps the local path for %s', (_name, overrides) => {
    expect(isLinkedWebSend(webChat(overrides), plain)).toBe(false);
  });

  it.each([
    ['local file attachments', { attachments: 1 }],
    ['editing a sent prompt', { attachments: 0, replaces: true }],
    ['a skill', { attachments: 0, skill: true }],
    ['notes riding with the message', { attachments: 0, notes: 1 }],
    ['a queue release, relay or loop', { attachments: 0, automated: true }],
  ])('keeps the local path for %s', (_name, request) => {
    expect(isLinkedWebSend(webChat(), request)).toBe(false);
  });
});

describe('isLinkedChatBusy', () => {
  it('is busy while this window replies or the web is still writing a reply', () => {
    expect(isLinkedChatBusy(webChat(), true)).toBe(true);
    const running = webChat({
      importOrigin: {
        kind: 'b4m-web',
        sourceId: 'nb1',
        importedAt: '',
        sourceUpdatedAt: '',
        runningSince: new Date().toISOString(),
      },
    });
    expect(isLinkedChatBusy(running, false)).toBe(true);
    expect(isLinkedChatBusy(webChat(), false)).toBe(false);
  });

  it('lets a running mark lapse once nothing has renewed it for the lease', () => {
    const since = Date.parse('2026-01-01T00:00:00.000Z');
    const origin = { runningSince: new Date(since).toISOString() };
    expect(isLinkedReplyRunning(origin, since + LINKED_RUNNING_LEASE_MS - 1)).toBe(true);
    expect(isLinkedReplyRunning(origin, since + LINKED_RUNNING_LEASE_MS)).toBe(false);
    expect(isLinkedReplyRunning({ runningSince: 'not a date' })).toBe(false);
    expect(isLinkedReplyRunning(undefined)).toBe(false);
  });

  it('stays busy while the window still draws the prompt it just sent', () => {
    const sent = webChat();
    sent.messages = [
      ...sent.messages,
      { id: `${OPTIMISTIC_ID_PREFIX}1`, role: 'user', content: 'next', createdAt: '2026-01-01T00:00:01.000Z' },
    ];
    expect(isLinkedChatBusy(sent, true)).toBe(true);
  });

  it('never blocks a chat that is not linked', () => {
    expect(isLinkedChatBusy(webChat({ mode: 'code' }), true)).toBe(false);
    expect(isLinkedWebSession(webChat({ mode: 'code' }))).toBe(false);
  });
});
