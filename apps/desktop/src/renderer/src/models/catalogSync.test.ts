import type { ChatModelOption } from '@shared/chat';
import type { LocalModelEntry } from '@shared/models';
import { describe, expect, it } from 'vitest';
import { missingFromCatalog } from './catalogSync';

const installed = (name: string, embeddings = false): LocalModelEntry => ({
  name,
  sizeBytes: 1,
  quantization: null,
  family: null,
  parameterSize: null,
  modifiedAt: null,
  capabilities: { tools: true, vision: false, thinking: false, embeddings, completion: !embeddings },
  loaded: false,
  fit: null,
});
const option = (name: string, extra: Partial<ChatModelOption> = {}): ChatModelOption => ({
  id: `local:ollama:${name}`,
  name,
  backend: 'ollama',
  ...extra,
});

describe('missingFromCatalog', () => {
  it('lists installed chat models the catalog lacks, sorted', () => {
    expect(missingFromCatalog([installed('b'), installed('a'), installed('c')], 'local', [option('c')])).toEqual([
      'a',
      'b',
    ]);
  });

  it('skips embedding-only models and matches names case-insensitively', () => {
    expect(missingFromCatalog([installed('embed', true), installed('Qwen')], 'local', [option('qwen')])).toEqual([]);
  });

  it('counts only entries of the same server, with local as the default', () => {
    const catalog = [option('m', { server: { id: 'gpu', name: 'gpu box' } }), option('n')];
    expect(missingFromCatalog([installed('m'), installed('n')], 'local', catalog)).toEqual(['m']);
    expect(missingFromCatalog([installed('m'), installed('n')], 'gpu', catalog)).toEqual(['n']);
  });

  it('counts an entry marked unavailable as missing', () => {
    expect(missingFromCatalog([installed('m')], 'local', [option('m', { unavailable: 'Not installed' })])).toEqual([
      'm',
    ]);
  });

  it('applies the chat filter of the server kind', () => {
    const caps = (embeddings: boolean, completion: boolean) => ({
      ...installed('x').capabilities,
      embeddings,
      completion,
    });
    const noCompletion = { ...installed('x'), capabilities: caps(false, false) };
    const both = { ...installed('y'), capabilities: caps(true, true) };
    const embedOnly = { ...installed('z'), capabilities: caps(true, false) };
    const models = [noCompletion, both, embedOnly];
    expect(missingFromCatalog(models, 'local', [], 'ollama')).toEqual(['y']);
    expect(missingFromCatalog(models, 'local', [], 'openai-compatible')).toEqual(['x', 'y']);
  });

  it('ignores hosted entries of the same name', () => {
    expect(missingFromCatalog([installed('m')], 'local', [{ id: 'x', name: 'm', backend: 'anthropic' }])).toEqual([
      'm',
    ]);
  });
});
