import type { ChatSpawnSuggestion } from '@shared/chat';
import { describe, expect, it, vi } from 'vitest';
import { sessionSpawn, sessionSuggestionDismiss, sessionSuggestionUpdate } from './hostTools';
import type { HostContext, SpawnSuggestionHost, ToolContext } from './types';

const suggestion: ChatSpawnSuggestion = {
  id: 'abc12345',
  title: 'Tidy imports',
  prompt: 'remove unused imports',
  base: 'main',
  branch: 'agent/tidy-imports',
  status: 'pending',
  revision: 0,
  createdAt: '2026-10-14T00:00:00.000Z',
};

function contextWith(suggestions?: SpawnSuggestionHost) {
  const host = {
    spawn: vi.fn(async () => ({ ok: true as const, session: { id: 'child', title: 'Tidy imports' } })),
    spawnBase: vi.fn(async () => 'main'),
    ...(suggestions ? { suggestions } : {}),
  } as unknown as HostContext;
  const context: ToolContext = { roots: [], signal: new AbortController().signal, host, report: undefined };
  return { context, host };
}

function suggestionHost(): SpawnSuggestionHost {
  return {
    suggest: vi.fn(async task => ({ ...suggestion, prompt: task.prompt, title: task.title ?? suggestion.title })),
    update: vi.fn(async (_id, changes) => ({
      ok: true as const,
      suggestion: { ...suggestion, ...changes, revision: 1 },
    })),
    dismiss: vi.fn(async () => ({ ok: true as const, suggestion: { ...suggestion, status: 'dismissed' as const } })),
  };
}

describe('session_spawn', () => {
  it('only suggests when a user is present, and asks for no approval', async () => {
    const suggestions = suggestionHost();
    const { context, host } = contextWith(suggestions);
    const input = { prompt: 'remove unused imports', title: 'Tidy imports', summary: 'one line' };

    expect(await sessionSpawn.needsApproval?.(input, context)).toBe(false);
    const result = await sessionSpawn.run(input, context);

    expect(suggestions.suggest).toHaveBeenCalledWith(input);
    expect(host.spawn).not.toHaveBeenCalled();
    expect(result).toContain('Suggested task abc12345');
    expect(result).toContain('Nothing has started');
    expect(result).toContain('session_suggestion_update');
  });

  it('starts through the approval-gated path where nobody is present to see a card', async () => {
    const { context, host } = contextWith();
    expect(await sessionSpawn.needsApproval?.({ prompt: 'x' }, context)).toBe(true);

    const prompt = await sessionSpawn.approval?.({ prompt: 'x', title: 'X' }, context);
    expect(prompt?.choice?.options.map(option => option.id)).toEqual(['worktree', 'local']);

    const result = await sessionSpawn.run({ prompt: 'x', placement: 'local' }, context);
    expect(host.spawn).toHaveBeenCalledWith('x', undefined, { kind: 'local' });
    expect(result).toContain('Started session child');
  });
});

describe('session_suggestion_update and session_suggestion_dismiss', () => {
  it('passes only the fields that change', async () => {
    const suggestions = suggestionHost();
    const { context } = contextWith(suggestions);
    const result = await sessionSuggestionUpdate.run({ id: 'abc12345', prompt: 'and sort them', title: ' ' }, context);
    expect(suggestions.update).toHaveBeenCalledWith('abc12345', { prompt: 'and sort them' });
    expect(result).toContain('Updated suggestion abc12345');
  });

  it('refuses an update that changes nothing', async () => {
    const { context } = contextWith(suggestionHost());
    await expect(sessionSuggestionUpdate.run({ id: 'abc12345' }, context)).rejects.toThrow(/at least one/);
  });

  it('reports a refusal from the host as a failure', async () => {
    const suggestions = suggestionHost();
    vi.mocked(suggestions.dismiss).mockResolvedValueOnce({ ok: false, message: 'already started' });
    const { context } = contextWith(suggestions);
    await expect(sessionSuggestionDismiss.run({ id: 'abc12345' }, context)).rejects.toThrow('already started');
  });

  it('dismisses a pending suggestion', async () => {
    const suggestions = suggestionHost();
    const { context } = contextWith(suggestions);
    expect(await sessionSuggestionDismiss.run({ id: 'abc12345', reason: 'done here' }, context)).toContain(
      'Nothing was started'
    );
  });

  it('refuses in a conversation with no user present', async () => {
    const { context } = contextWith();
    await expect(sessionSuggestionDismiss.run({ id: 'abc12345' }, context)).rejects.toThrow(/no user present/);
  });
});
