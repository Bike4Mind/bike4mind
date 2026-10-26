import { describe, expect, it, vi } from 'vitest';
import { classifyLicenses, parseOllamaName, readOllamaManifest, type FetchLike } from './ollamaRegistry';

const digest = (char: string) => `sha256:${char.repeat(64)}`;
const APACHE = 'Apache License\n                           Version 2.0, January 2004\n';
const MIT =
  'MIT License\n\nCopyright (c) 2024\n\nPermission is hereby granted, free of charge, to any person obtaining a copy';

describe('parseOllamaName', () => {
  it('fills in the library namespace and the latest tag', () => {
    expect(parseOllamaName('gemma3')).toEqual({
      namespace: 'library',
      model: 'gemma3',
      tag: 'latest',
      page: 'https://ollama.com/library/gemma3',
    });
    expect(parseOllamaName('someone/model:q4')).toEqual({
      namespace: 'someone',
      model: 'model',
      tag: 'q4',
      page: 'https://ollama.com/someone/model',
    });
  });

  it('rejects names that would change the registry path', () => {
    for (const name of ['a/b/c', '../x', 'x:../y', 'x:', 'x?y', '']) {
      expect(() => parseOllamaName(name)).toThrow(/Not an Ollama model name/);
    }
  });
});

describe('readOllamaManifest', () => {
  const manifest = {
    layers: [
      { mediaType: 'application/vnd.ollama.image.model', digest: digest('a'), size: 270_000_000 },
      { mediaType: 'application/vnd.ollama.image.license', digest: digest('b'), size: 11_000 },
      { mediaType: 'application/vnd.ollama.image.params', digest: digest('c'), size: 100 },
    ],
  };

  it('sums the layers and reads each license layer', async () => {
    const fetchImpl = vi.fn<FetchLike>(async url =>
      url.endsWith('/manifests/270m') ? Response.json(manifest) : new Response('Gemma Terms of Use\n...')
    );
    const info = await readOllamaManifest('gemma3:270m', new AbortController().signal, fetchImpl);
    expect(info).toEqual({ sizeBytes: 270_011_100, licenses: ['Gemma Terms of Use\n...'] });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://registry.ollama.ai/v2/library/gemma3/manifests/270m',
      expect.objectContaining({ headers: { accept: 'application/vnd.docker.distribution.manifest.v2+json' } })
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://registry.ollama.ai/v2/library/gemma3/blobs/${digest('b')}`,
      expect.anything()
    );
  });

  it('reports a missing model and refuses a manifest with an odd digest', async () => {
    const signal = new AbortController().signal;
    await expect(readOllamaManifest('nope', signal, async () => new Response('', { status: 404 }))).rejects.toThrow(
      /no model named nope/
    );
    const odd = { layers: [{ mediaType: 'application/vnd.ollama.image.license', digest: '../x', size: 1 }] };
    await expect(readOllamaManifest('x', signal, async () => Response.json(odd))).rejects.toThrow(
      /unreadable manifest/
    );
  });
});

describe('classifyLicenses', () => {
  it('counts only the standard permissive texts as permissive', () => {
    expect(classifyLicenses([APACHE])).toEqual({ title: 'Apache License', permissive: true });
    expect(classifyLicenses([MIT, APACHE])).toEqual({ title: 'MIT License + Apache License', permissive: true });
  });

  it('treats custom terms, extra use restrictions and a missing license as restricted', () => {
    expect(classifyLicenses(['LLAMA 3.2 COMMUNITY LICENSE AGREEMENT\n...'])).toEqual({
      title: 'LLAMA 3.2 COMMUNITY LICENSE AGREEMENT',
      permissive: false,
    });
    expect(classifyLicenses([`${APACHE}\nSee the Acceptable Use Policy.`]).permissive).toBe(false);
    expect(classifyLicenses([MIT, 'Gemma Terms of Use']).permissive).toBe(false);
    expect(classifyLicenses([])).toEqual({ title: 'none declared', permissive: false });
    expect(classifyLicenses([''])).toEqual({ title: 'license text not shown', permissive: false });
  });
});
