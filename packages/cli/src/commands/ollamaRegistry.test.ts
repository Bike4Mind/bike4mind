import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { classifyLicenses, parseOllamaName, readOllamaManifest, type FetchLike } from './ollamaRegistry';

const digest = (char: string) => `sha256:${char.repeat(64)}`;
const APACHE = readFileSync(join(__dirname, '__fixtures__', 'apache-2.0.txt'), 'utf-8');
const MIT_BODY = [
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
  'SOFTWARE.',
].join('\n');
const MIT = `MIT License\n\nCopyright (c) 2023 DeepSeek\n\n${MIT_BODY}\n`;
const ADDENDUM =
  'ACME MODEL LICENSE ADDENDUM\nCommercial use requires a separate paid agreement with ACME. ' +
  'You may not use the Model or its outputs to train other models or for military purposes.';

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
    expect(info).toEqual({
      digest: `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`,
      layers: [digest('a'), digest('b'), digest('c')],
      sizeBytes: 270_011_100,
      licenses: ['Gemma Terms of Use\n...'],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://registry.ollama.ai/v2/library/gemma3/manifests/270m',
      expect.objectContaining({ headers: { accept: 'application/vnd.docker.distribution.manifest.v2+json' } })
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://registry.ollama.ai/v2/library/gemma3/blobs/${digest('b')}`,
      expect.anything()
    );
  });

  it('fetches a license layer the manifest repeats once', async () => {
    const license = manifest.layers[1];
    const repeated = { layers: [...manifest.layers, license, license] };
    const fetchImpl = vi.fn<FetchLike>(async url =>
      url.includes('/manifests/') ? Response.json(repeated) : new Response('LLAMA 4 COMMUNITY LICENSE AGREEMENT')
    );
    const info = await readOllamaManifest('llama4', new AbortController().signal, fetchImpl);
    expect(info.licenses).toEqual(['LLAMA 4 COMMUNITY LICENSE AGREEMENT']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
  it('counts the Apache-2.0 and MIT templates as permissive, with a filled-in copyright line', () => {
    expect(classifyLicenses([APACHE])).toEqual({ title: 'Apache-2.0', permissive: true });
    const filled = APACHE.replace('Copyright [yyyy] [name of copyright owner]', 'Copyright 2024 Alibaba Cloud');
    expect(classifyLicenses([filled]).permissive).toBe(true);
    expect(classifyLicenses([APACHE.slice(0, APACHE.indexOf('APPENDIX'))]).permissive).toBe(true);
    expect(classifyLicenses([MIT, APACHE])).toEqual({ title: 'MIT + Apache-2.0', permissive: true });
  });

  it('accepts the MIT name and copyright lines, and markdown quoting', () => {
    const phi = `Microsoft.\nCopyright (c) Microsoft Corporation.\n\nMIT License\n\n${MIT_BODY.replace('"AS IS"', '*AS IS*')}`;
    expect(classifyLicenses([phi])).toEqual({ title: 'MIT', permissive: true });
    expect(classifyLicenses([MIT.replace('(c)', '\u00a9')])).toEqual({ title: 'MIT', permissive: true });
  });

  it('treats a template with added terms as restricted', () => {
    expect(classifyLicenses([`${APACHE}\n\n${ADDENDUM}`]).permissive).toBe(false);
    expect(classifyLicenses([`${ADDENDUM}\n\n${APACHE}`]).permissive).toBe(false);
    const inserted = APACHE.replace('END OF TERMS', 'No military use.\n\nEND OF TERMS');
    expect(classifyLicenses([inserted]).permissive).toBe(false);
    expect(classifyLicenses([`${MIT}\n${ADDENDUM}`]).permissive).toBe(false);
    expect(classifyLicenses([`Not for military use.\n\n${MIT}`]).permissive).toBe(false);
    const sneaky = APACHE.replace('[yyyy] [name of copyright owner]', '2024 Acme. Commercial use requires a fee');
    expect(classifyLicenses([sneaky]).permissive).toBe(false);
    expect(classifyLicenses(['Apache License\n  Version 2.0, January 2004\n']).permissive).toBe(false);
  });

  it.each([
    ['Chinese restriction', '\u4ec5\u9650\u975e\u5546\u4e1a\u7528\u9014'],
    ['Japanese restriction', '\u5546\u7528\u5229\u7528\u7981\u6b62'],
    ['mixed restriction', 'DeepSeek \u5546\u7528\u5229\u7528\u7981\u6b62'],
    ['symbol restriction', 'DeepSeek \u{1f6ab}\u{1f4b0}'],
    ['format character', 'DeepSeek\u200d'],
    ['combining character', 'DeepSeek\u0301'],
    ['punctuation-only line', '!!!'],
    ['copyright restriction', 'Copyright 2024 \u5546\u7528\u5229\u7528\u7981\u6b62'],
  ])('requires acceptance for a MIT template with a %s', (_label, addition) => {
    expect(classifyLicenses([`${addition}\n${MIT}`]).permissive).toBe(false);
  });

  it('requires acceptance for unfamiliar copyright text in either template', () => {
    const holder = 'Copyright 2024 Acme \u5546\u7528\u5229\u7528\u7981\u6b62';
    expect(classifyLicenses([MIT.replace('Copyright (c) 2023 DeepSeek', holder)]).permissive).toBe(false);
    expect(classifyLicenses([APACHE.replace('Copyright [yyyy] [name of copyright owner]', holder)]).permissive).toBe(
      false
    );
  });

  it('requires acceptance for an unfamiliar name-only preamble', () => {
    expect(classifyLicenses([`\u6df1\u5ea6\u6c42\u7d22\n${MIT}`]).permissive).toBe(false);
  });

  it('treats custom terms and a missing license as restricted and names them by their title line', () => {
    expect(classifyLicenses(['LLAMA 3.2 COMMUNITY LICENSE AGREEMENT\n...'])).toEqual({
      title: 'LLAMA 3.2 COMMUNITY LICENSE AGREEMENT',
      permissive: false,
    });
    expect(classifyLicenses(['**Llama 3.2** **Acceptable Use Policy**\n...']).title).toBe(
      'Llama 3.2 Acceptable Use Policy'
    );
    expect(classifyLicenses(['# Mistral AI Non-Production License\n']).title).toBe('Mistral AI Non-Production License');
    expect(classifyLicenses([MIT, 'Gemma Terms of Use']).permissive).toBe(false);
    expect(classifyLicenses([])).toEqual({ title: 'none declared', permissive: false });
    expect(classifyLicenses([''])).toEqual({ title: 'license text not shown', permissive: false });
  });

  it('lists a repeated license once', () => {
    expect(classifyLicenses(['Gemma Terms of Use', 'Gemma Terms of Use'])).toEqual({
      title: 'Gemma Terms of Use',
      permissive: false,
    });
  });
});
