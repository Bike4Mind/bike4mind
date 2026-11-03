import { describe, expect, it } from 'vitest';
import { loadedStateOf, loadedStateTarget } from './loadedState';

const entry = (name: string, expiresAt: string | null = null) => ({
  name,
  sizeBytes: 1,
  vramBytes: 1,
  contextLength: null,
  expiresAt,
});

describe('loadedStateTarget', () => {
  it('maps the runtime id inside a local model id to a server', () => {
    expect(loadedStateTarget('local:ollama:qwen3:8b')).toEqual({ serverId: 'local', model: 'qwen3:8b' });
    expect(loadedStateTarget('local:srv-abc:hf.co/org/repo:Q4_K_M')).toEqual({
      serverId: 'abc',
      model: 'hf.co/org/repo:Q4_K_M',
    });
    expect(loadedStateTarget('local:other:qwen')).toBeNull();
    expect(loadedStateTarget('local:')).toBeNull();
    expect(loadedStateTarget('gpt-5')).toBeNull();
  });
});

describe('loadedStateOf', () => {
  it('treats a bare name and its :latest tag as the same model', () => {
    expect(loadedStateOf([entry('llama3:latest')], 'llama3')).toEqual({ kind: 'loaded', expiresAt: null });
    expect(loadedStateOf([entry('llama3')], 'llama3:latest')).toEqual({ kind: 'loaded', expiresAt: null });
    expect(loadedStateOf([entry('llama3:70b')], 'llama3')).toEqual({ kind: 'unloaded' });
  });

  it('does not read a registry port as a tag', () => {
    expect(loadedStateOf([entry('host:5000/team/model:latest')], 'host:5000/team/model')).toMatchObject({
      kind: 'loaded',
    });
  });

  it('parses the keep-alive expiry, and drops one it cannot read', () => {
    expect(loadedStateOf([entry('qwen3:8b', '2026-11-02T12:05:00.123Z')], 'qwen3:8b')).toEqual({
      kind: 'loaded',
      expiresAt: Date.parse('2026-11-02T12:05:00.123Z'),
    });
    expect(loadedStateOf([entry('qwen3:8b', 'soon')], 'qwen3:8b')).toEqual({ kind: 'loaded', expiresAt: null });
  });

  it('is unloaded when nothing matching is in memory', () => {
    expect(loadedStateOf([], 'qwen3:8b')).toEqual({ kind: 'unloaded' });
  });
});
