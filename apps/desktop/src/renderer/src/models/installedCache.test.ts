import { describe, expect, it } from 'vitest';
import type { LocalModelEntry } from '@shared/models';
import type { ModelServerView } from '@shared/modelServers';
import { InstalledCache, listedAtLabel, serverIdentity } from './installedCache';

function model(name: string): LocalModelEntry {
  return {
    name,
    sizeBytes: 1,
    quantization: null,
    family: null,
    parameterSize: null,
    modifiedAt: null,
    capabilities: { tools: true, vision: false, thinking: false, embeddings: false, completion: true },
    loaded: false,
    fit: null,
  };
}

function view(id: string, extra: Partial<ModelServerView> = {}): ModelServerView {
  return {
    id,
    name: id,
    local: false,
    kind: 'ollama',
    transport: 'http',
    address: `http://${id}:11434`,
    access: 'manage',
    auth: { type: 'none' },
    credentialsPersisted: true,
    credentialsMissing: false,
    unencrypted: true,
    health: { state: 'online', version: null, latencyMs: null, checkedAt: null, error: null },
    models: [],
    specs: null,
    ...extra,
  };
}

describe('listedAtLabel', () => {
  const noon = new Date(2026, 10, 2, 12, 0).getTime();

  it('gives only the time for a listing from today', () => {
    const at = new Date(2026, 10, 2, 9, 30).getTime();
    expect(listedAtLabel(at, noon)).toBe(new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  });

  it('adds the date for a listing from another day', () => {
    const at = new Date(2026, 10, 1, 23, 50).getTime();
    const label = listedAtLabel(at, noon);
    expect(label).toContain(new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' }));
    expect(label).toContain(new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  });
});

describe('InstalledCache', () => {
  const gpu = view('gpu');
  const lab = view('lab');

  it('returns the last listing for the same server and identity', () => {
    const cache = new InstalledCache();
    expect(cache.get('gpu', serverIdentity(gpu))).toBeNull();
    cache.set('gpu', serverIdentity(gpu), [model('a')], 1_000);
    expect(cache.get('gpu', serverIdentity(gpu))).toEqual({ models: [model('a')], listedAt: 1_000 });
    expect(cache.get('lab', serverIdentity(lab))).toBeNull();
  });

  it('replaces an entry with the newer listing', () => {
    const cache = new InstalledCache();
    cache.set('gpu', serverIdentity(gpu), [model('a')], 1_000);
    cache.set('gpu', serverIdentity(gpu), [model('a'), model('b')], 2_000);
    expect(cache.get('gpu', serverIdentity(gpu))?.models.map(entry => entry.name)).toEqual(['a', 'b']);
    expect(cache.get('gpu', serverIdentity(gpu))?.listedAt).toBe(2_000);
  });

  it('misses without an identity, or when the address or kind changed', () => {
    const cache = new InstalledCache();
    cache.set('gpu', serverIdentity(gpu), [model('a')], 1_000);
    expect(cache.get('gpu', null)).toBeNull();
    expect(cache.get('gpu', serverIdentity({ ...gpu, address: 'http://other:11434' }))).toBeNull();
    expect(cache.get('gpu', serverIdentity({ ...gpu, kind: 'openai-compatible' }))).toBeNull();
    expect(cache.get('gpu', serverIdentity({ ...gpu, transport: 'ssh' }))).toBeNull();
  });

  it('drops removed servers and servers saved at another address, and keeps the rest', () => {
    const cache = new InstalledCache();
    cache.set('gpu', serverIdentity(gpu), [model('a')], 1_000);
    cache.set('lab', serverIdentity(lab), [model('b')], 1_000);
    const shared = view('shared');
    cache.set('shared', serverIdentity(shared), [model('c')], 1_000);

    cache.retain([
      { ...gpu, name: 'renamed', access: 'chat' },
      { ...shared, address: 'http://moved:11434' },
    ]);

    expect(cache.get('gpu', serverIdentity(gpu))?.models).toEqual([model('a')]);
    expect(cache.get('lab', serverIdentity(lab))).toBeNull();
    expect(cache.get('shared', serverIdentity(shared))).toBeNull();
    // A server saved back at its old address does not get the dropped entry back.
    cache.retain([gpu, lab, shared]);
    expect(cache.get('lab', serverIdentity(lab))).toBeNull();
  });
});
