import { describe, expect, it } from 'vitest';
import {
  isLocalBackend,
  isLocalModel,
  isTurnBudgetStop,
  lastBoundaryIndex,
  localBackend,
  localModelId,
  messagesSinceBoundary,
  parseLocalModelId,
  pickLocalModel,
  type ChatMessage,
} from './chat';

describe('pickLocalModel', () => {
  it('never picks a model whose server is down', () => {
    const down = { id: 'local:srv-abc123:qwen', unavailable: 'gpu box is unreachable' };
    const up = { id: 'local:ollama:qwen' };
    expect(pickLocalModel([down, up])).toBe(up.id);
    expect(pickLocalModel([down, up], down.id)).toBe(up.id);
    expect(pickLocalModel([down])).toBeNull();
  });

  it('keeps the remembered model while it is usable', () => {
    expect(pickLocalModel([{ id: 'a' }, { id: 'b' }], 'b')).toBe('b');
  });
});

describe('local model ids', () => {
  it('round-trips a runtime and a model containing colons', () => {
    const id = localModelId('ollama', 'qwen3:8b');
    expect(id).toBe('local:ollama:qwen3:8b');
    expect(parseLocalModelId(id)).toEqual({ runtimeId: 'ollama', model: 'qwen3:8b' });
    expect(parseLocalModelId('local:lmstudio:org/model:q4')).toEqual({ runtimeId: 'lmstudio', model: 'org/model:q4' });
  });

  it('encodes colons in the runtime id and keeps the default daemon id unchanged', () => {
    expect(localModelId('ollama', 'llama3.2')).toBe('local:ollama:llama3.2');
    const withPort = localModelId('ollama:127.0.0.1:11435', 'qwen2.5:0.5b');
    expect(withPort).toBe('local:ollama%3A127.0.0.1%3A11435:qwen2.5:0.5b');
    expect(parseLocalModelId(withPort)).toEqual({ runtimeId: 'ollama:127.0.0.1:11435', model: 'qwen2.5:0.5b' });
  });

  it('round-trips a URL runtime id with a model containing colons and slashes', () => {
    const runtimeId = 'openai-compatible:https://host:8443/v1';
    const id = localModelId(runtimeId, 'org/model:q4/x');
    expect(parseLocalModelId(id)).toEqual({ runtimeId, model: 'org/model:q4/x' });
    expect(isLocalModel(id)).toBe(true);
  });

  it('returns null for a malformed encoded runtime but still fails closed', () => {
    const id = 'local:bad%E0%A4%A:model';
    expect(parseLocalModelId(id)).toBeNull();
    expect(isLocalModel(id)).toBe(true);
  });

  it('recognizes any runtime and rejects hosted and malformed ids', () => {
    expect(isLocalModel('local:lmstudio:some-model')).toBe(true);
    for (const id of ['claude-sonnet', 'locally:ollama:x', 'local']) {
      expect(isLocalModel(id)).toBe(false);
      expect(parseLocalModelId(id)).toBeNull();
    }
  });

  it('fails closed on malformed local ids while refusing to parse them', () => {
    for (const id of ['local:', 'local:ollama', 'local:ollama:', 'local::x']) {
      expect(isLocalModel(id)).toBe(true);
      expect(parseLocalModelId(id)).toBeNull();
    }
  });

  it('treats ollama and local-* backends as local', () => {
    expect(isLocalBackend({ backend: 'ollama' })).toBe(true);
    expect(isLocalBackend({ backend: 'local-lmstudio' })).toBe(true);
    expect(isLocalBackend({ backend: 'anthropic' })).toBe(false);
    expect(isLocalBackend({})).toBe(false);
  });

  it('derives the backend label from the runtime', () => {
    expect(localBackend('ollama')).toBe('local-ollama');
  });
});

describe('isTurnBudgetStop', () => {
  it('covers every budget the agent loop enforces', () => {
    // Guards the pairing this predicate exists for: main sets these three, and the thread draws
    // a Continue for whatever it admits. A budget added on one side and not here reaches
    // neither, and silently goes back to being a dead end.
    expect(['tool_turn_limit', 'turn_time_limit', 'tool_stall_limit'].every(isTurnBudgetStop)).toBe(true);
  });

  it('leaves the stops that are not the loop running out of budget', () => {
    // A finished reply, a server-side truncation and the user pressing Stop are all things
    // Continue must not offer to carry on.
    expect([undefined, 'stop', 'end_turn', 'max_tokens', 'aborted'].some(isTurnBudgetStop)).toBe(false);
  });
});

function message(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'user', content: id, createdAt: '2026-01-01T00:00:00.000Z', ...extra };
}

const boundary = (id: string, kind: 'clear' | 'compact' = 'clear'): ChatMessage =>
  message(id, { system: true, boundary: { kind }, content: kind === 'compact' ? 'summary' : '' });

describe('messagesSinceBoundary', () => {
  it('is the whole conversation when it has no boundary', () => {
    const messages = [message('a'), message('b')];
    expect(messagesSinceBoundary(messages)).toEqual(messages);
    expect(lastBoundaryIndex(messages)).toBe(-1);
  });

  it('drops what came before and keeps the marker, so a summary leads what is sent', () => {
    const marker = boundary('m', 'compact');
    expect(messagesSinceBoundary([message('a'), message('b'), marker, message('c')])).toEqual([marker, message('c')]);
  });

  // The whole reason a boundary is a marker rather than a stored cut: compacting a compacted
  // conversation needs no bookkeeping, because only the last marker is ever consulted.
  it('lets a second boundary supersede the first', () => {
    const first = boundary('m1', 'compact');
    const second = boundary('m2', 'compact');
    const kept = messagesSinceBoundary([message('a'), first, message('b'), second, message('c')]);
    expect(kept).toEqual([second, message('c')]);
    expect(kept).not.toContain(first);
  });

  it('keeps nothing but the marker straight after a clear', () => {
    const marker = boundary('m');
    expect(messagesSinceBoundary([message('a'), message('b'), marker])).toEqual([marker]);
  });
});
