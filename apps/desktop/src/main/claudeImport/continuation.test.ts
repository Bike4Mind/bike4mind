import type { ChatMessage, ChatSession } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import {
  IMPORTED_COMPACT_CHARS,
  importedHistoryNeedsCompaction,
  importedTurnAsText,
  isImportedToolTurn,
} from './continuation';

const at = '2026-01-01T00:00:00.000Z';

function session(messages: ChatMessage[], imported = true): ChatSession {
  return {
    id: 'cc-s',
    title: 't',
    model: 'm',
    createdAt: at,
    updatedAt: at,
    mode: 'chat',
    approvalMode: 'ask',
    reasoningEffort: 'default',
    ...(imported
      ? { importOrigin: { kind: 'claude-code' as const, sourceId: 's', importedAt: at, sourceUpdatedAt: at } }
      : {}),
    messages,
  };
}

describe('continuing an imported session', () => {
  it('flattens an imported tool turn into prose with capped results', () => {
    const message: ChatMessage = {
      id: 'cc-1',
      role: 'assistant',
      content: 'Checked.',
      createdAt: at,
      toolCalls: [
        { id: 't1', name: 'bash_execute', input: { command: 'ls' }, status: 'done', preview: 'x'.repeat(5000) },
        { id: 't2', name: 'Agent', input: {}, status: 'error', error: 'boom' },
      ],
    };
    expect(isImportedToolTurn(message)).toBe(true);
    expect(isImportedToolTurn({ ...message, id: 'own' })).toBe(false);
    const text = importedTurnAsText(message, message.content);
    expect(text.startsWith('Checked.\n\n[Earlier tool call: bash_execute ls]\n\n[Result]\n')).toBe(true);
    expect(text).toContain('[... truncated ...]');
    expect(text.endsWith('[Earlier tool call: Agent]\n\n[Error]\nboom')).toBe(true);
    expect(text.length).toBeLessThan(2000);
  });

  it('compacts first only when the imported history since the last boundary is large', () => {
    const big = (id: string): ChatMessage => ({
      id,
      role: 'user',
      content: 'y'.repeat(IMPORTED_COMPACT_CHARS / 2 + 1),
      createdAt: at,
    });
    expect(importedHistoryNeedsCompaction(session([big('cc-1')]))).toBe(false);
    expect(importedHistoryNeedsCompaction(session([big('cc-1'), big('cc-2')]))).toBe(true);
    // Not an import, or already compacted past the imported part: nothing to do.
    expect(importedHistoryNeedsCompaction(session([big('cc-1'), big('cc-2')], false))).toBe(false);
    const boundary: ChatMessage = {
      id: 'own',
      role: 'user',
      content: 'summary',
      createdAt: at,
      system: true,
      boundary: { kind: 'compact' },
    };
    expect(importedHistoryNeedsCompaction(session([big('cc-1'), big('cc-2'), boundary]))).toBe(false);
  });
});
