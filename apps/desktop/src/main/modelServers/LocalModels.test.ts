import { describe, expect, it, vi } from 'vitest';
import type { LocalChat } from '../chat/localChat';
import type { OllamaLocal } from '../chat/OllamaLocal';
import { credentialInput } from './ipc';
import { LocalModels } from './LocalModels';
import { credentialHeaders } from './ModelServerStore';

function chatStub(): LocalChat {
  return {
    stream: vi.fn(async () => undefined),
    contextTokens: vi.fn(async () => 4096),
    growFor: vi.fn(async () => undefined),
  };
}

describe('LocalModels', () => {
  const computer = { ...chatStub(), models: vi.fn(async () => [{ id: 'local:ollama:qwen', name: 'qwen' }]) };
  const server = chatStub();
  const registry = {
    models: vi.fn(async () => [
      { id: 'local:srv-abc123:qwen', name: 'qwen', server: { id: 'abc123', name: 'gpu box' } },
    ]),
    chatFor: vi.fn((runtimeId: string) => (runtimeId.startsWith('srv-') ? server : null)),
  };
  const local = new LocalModels(computer as unknown as OllamaLocal, registry);

  it("sends a saved server's model to that server and every other local model to this computer", async () => {
    await local.stream({ model: 'local:srv-abc123:qwen', messages: [] }, () => undefined);
    expect(server.stream).toHaveBeenCalledTimes(1);
    expect(computer.stream).not.toHaveBeenCalled();

    await local.stream({ model: 'local:ollama:qwen', messages: [] }, () => undefined);
    expect(computer.stream).toHaveBeenCalledTimes(1);
    expect(registry.chatFor).toHaveBeenLastCalledWith('ollama');
  });

  it("lists this computer's models first, and still lists them when the servers fail", async () => {
    expect((await local.models()).map(model => model.id)).toEqual(['local:ollama:qwen', 'local:srv-abc123:qwen']);
    registry.models.mockRejectedValueOnce(new Error('boom'));
    expect((await local.models()).map(model => model.id)).toEqual(['local:ollama:qwen']);
  });
});

describe('credentialInput', () => {
  it('keeps an over-long token whole so the store can reject it instead of saving it truncated', () => {
    const token = 'a'.repeat(5_000);
    const input = credentialInput({ type: 'bearer', token });
    expect(input.type === 'bearer' && input.token.length).toBeGreaterThan(4_096);
    expect(() => credentialHeaders(input)).toThrow(/longer than 4096/);
    const header = credentialInput({ type: 'header', name: 'X-Key', value: token });
    expect(() => credentialHeaders(header)).toThrow(/longer than 4096/);
    expect(() => credentialHeaders(credentialInput({ type: 'header', name: 'x'.repeat(100), value: 'v' }))).toThrow(
      /header name/
    );
  });

  it('trims a pasted token before measuring it, so leading whitespace cannot hide truncation', () => {
    const token = 'a'.repeat(4_096);
    const input = credentialInput({ type: 'bearer', token: `\n\n${token}` });
    expect(input.type === 'bearer' && input.token).toBe(token);
    expect(() => credentialHeaders(credentialInput({ type: 'bearer', token: `\n\n${token}b` }))).toThrow(
      /longer than 4096/
    );
  });

  it('turns anything malformed from the renderer into no credential', () => {
    expect(credentialInput(undefined)).toEqual({ type: 'none' });
    expect(credentialInput({ type: 'basic', token: 'x' })).toEqual({ type: 'none' });
    expect(credentialInput({ type: 'bearer', token: 42 })).toEqual({ type: 'bearer', token: '' });
    expect(credentialInput({ type: 'header', name: 'X-Key', value: 'v', extra: true })).toEqual({
      type: 'header',
      name: 'X-Key',
      value: 'v',
    });
  });
});
