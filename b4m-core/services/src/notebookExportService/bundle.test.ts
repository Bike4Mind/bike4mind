import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createExportBundle,
  createNotebookBundle,
  readExportBundle,
  readNotebookBundle,
  type BundleRead,
  type BundleWrite,
} from './bundle';
import type { ExportedNotebook } from './types';

function memoryBundle() {
  const data = new Map<string, Uint8Array>();
  const write: BundleWrite = async (path, bytes) => {
    data.set(path, Buffer.from(bytes));
  };
  const read: BundleRead = async path => {
    const bytes = data.get(path);
    if (!bytes) throw new Error(`Missing bundle entry: ${path}`);
    return bytes;
  };
  return { data, write, read };
}

const notebook: ExportedNotebook = {
  id: 'nb-1',
  name: 'A notebook',
  firstCreated: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-01T00:00:00.000Z',
  tags: [],
  isAutoNamed: false,
  chatHistory: [
    {
      id: 'msg-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'message',
      prompt: 'Hello',
      reply: 'Hi',
      images: [Buffer.from('image').toString('base64')],
      status: 'done',
      pinned: false,
    },
  ],
  knowledge: [
    {
      id: 'file-1',
      name: 'hello.txt',
      mimeType: 'text/plain',
      size: 5,
      uploadedAt: '2026-01-01T00:00:00.000Z',
      content: Buffer.from('hello').toString('base64'),
    },
  ],
  artifacts: [],
  tools: [],
  agents: [],
};

describe('v2 bundle', () => {
  it('writes a generic manifest last and verifies collection counts, hashes and external bytes', async () => {
    const { data, write, read } = memoryBundle();
    const paths: string[] = [];
    const manifest = await createExportBundle(
      {
        exportedAt: '2026-01-01T00:00:00.000Z',
        collections: { custom: [{ id: 1 }, { id: 2 }] },
        files: [{ path: 'files/example', content: Buffer.from('hello') }],
      },
      async (path, bytes) => {
        paths.push(path);
        await write(path, bytes);
      }
    );
    expect(paths.at(-1)).toBe('manifest.json');
    expect(manifest.collections.custom.count).toBe(2);
    expect(manifest.files[0].bytes).toBe(5);
    expect((await readExportBundle(read)).collections.custom).toEqual([{ id: 1 }, { id: 2 }]);
    data.set('collections/custom.jsonl', Buffer.from('{"id":3}\n'));
    await expect(readExportBundle(read)).rejects.toThrow('checksum mismatch');
  });

  it('streams each JSONL row through an append sink without accumulating the collection', async () => {
    const { data, write, read } = memoryBundle();
    const appended: string[] = [];
    async function* rows() {
      yield { id: 1 };
      yield { id: 2 };
    }
    const manifest = await createExportBundle(
      { collections: { custom: rows(), empty: [] } },
      write,
      async (path, bytes) => {
        appended.push(path);
        data.set(path, Buffer.concat([Buffer.from(data.get(path) ?? []), Buffer.from(bytes)]));
      }
    );
    expect(appended).toEqual(['collections/custom.jsonl', 'collections/custom.jsonl']);
    expect(manifest.collections.empty).toMatchObject({ count: 0, bytes: 0 });
    expect((await readExportBundle(read)).collections.custom).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('externalizes knowledge bytes and reconstructs the import-compatible notebook', async () => {
    const { data, write, read } = memoryBundle();
    const manifest = await createNotebookBundle([notebook], write);
    expect(manifest.files).toEqual([
      expect.objectContaining({ bytes: 5, path: expect.stringMatching(/^files\/[a-f0-9]{64}$/) }),
      expect.objectContaining({ bytes: 5, path: expect.stringMatching(/^files\/[a-f0-9]{64}$/) }),
    ]);
    expect(Buffer.from(data.get('collections/knowledge.jsonl')!).toString()).not.toContain('aGVsbG8=');
    expect(Buffer.from(data.get('collections/chat-messages.jsonl')!).toString()).not.toContain('aW1hZ2U=');
    const restored = await readNotebookBundle(read);
    expect(restored).toMatchObject({ exportVersion: '2.0.0', platform: 'bike4mind', notebooks: [notebook] });
    data.set(manifest.files[0].path, Buffer.from('tamper'));
    await expect(readNotebookBundle(read)).rejects.toThrow('checksum mismatch');
  });

  it('rejects many references to one file before expanding them into base64', async () => {
    const { write, read } = memoryBundle();
    const image = Buffer.alloc(1024, 42).toString('base64');
    const source = {
      ...notebook,
      knowledge: [],
      chatHistory: Array.from({ length: 10 }, (_, index) => ({
        ...notebook.chatHistory[0],
        id: `msg-${index}`,
        images: [image],
      })),
    };
    const manifest = await createNotebookBundle([source], write);
    expect(manifest.files).toHaveLength(1);
    const storedBytes =
      Object.values(manifest.collections).reduce((sum, entry) => sum + entry.bytes, 0) +
      manifest.files.reduce((sum, entry) => sum + entry.bytes, 0);
    const twoImagesBudget = storedBytes + 2 * image.length;
    await expect(readNotebookBundle(read, storedBytes - 1)).rejects.toThrow('Bundle byte budget exceeded');
    await expect(readNotebookBundle(read, twoImagesBudget)).rejects.toThrow('Bundle byte budget exceeded');
    expect((await readNotebookBundle(read, storedBytes + 10 * image.length)).notebooks[0].chatHistory).toHaveLength(10);
  });

  it('keeps image storage keys when explicitly requested', async () => {
    const { data, write, read } = memoryBundle();
    const source = {
      ...notebook,
      knowledge: [],
      chatHistory: [{ ...notebook.chatHistory[0], images: ['images/key-1'] }],
    };
    const manifest = await createNotebookBundle([source], write, { imagesAsKeys: true });
    expect(manifest.files).toEqual([]);
    expect((await readNotebookBundle(read)).notebooks[0].chatHistory[0].images).toEqual(['images/key-1']);
    expect(data.has('manifest.json')).toBe(true);
  });

  it('rejects unsafe paths and orphaned child records', async () => {
    const { data, write, read } = memoryBundle();
    await expect(
      createExportBundle({ collections: {}, files: [{ path: 'files/../escape', content: Buffer.from('x') }] }, write)
    ).rejects.toThrow('Invalid file path');
    await createExportBundle(
      {
        collections: {
          notebooks: [],
          'chat-messages': [{ notebookId: 'missing' }],
          knowledge: [],
          artifacts: [],
          tools: [],
          agents: [],
        },
      },
      write
    );
    await expect(readNotebookBundle(read)).rejects.toThrow('Unknown notebook');
    const manifest = JSON.parse(Buffer.from(data.get('manifest.json')!).toString());
    manifest.collections.notebooks.count = 1;
    data.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    await expect(readExportBundle(read)).rejects.toThrow('count mismatch');
  });

  it('rejects malformed manifests and JSONL lines with a located message', async () => {
    const { data, write, read } = memoryBundle();
    data.set('manifest.json', Buffer.from('{'));
    await expect(readExportBundle(read)).rejects.toThrow('Invalid JSON in manifest.json');
    data.set('manifest.json', Buffer.from('null'));
    await expect(readExportBundle(read)).rejects.toThrow('Invalid bundle manifest');
    await createExportBundle({ collections: { custom: [{ id: 1 }, { id: 2 }] } }, write);
    const manifest = JSON.parse(Buffer.from(data.get('manifest.json')!).toString());
    const broken = Buffer.from('{"id":1}\n{oops\n');
    data.set('collections/custom.jsonl', broken);
    manifest.collections.custom.bytes = broken.length;
    manifest.collections.custom.sha256 = createHash('sha256').update(broken).digest('hex');
    data.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    await expect(readExportBundle(read)).rejects.toThrow('Invalid JSON in collections/custom.jsonl line 2');
  });

  it('never reads a traversal or non-files path listed in a manifest', async () => {
    const { data, write } = memoryBundle();
    await createExportBundle({ collections: {} }, write);
    const manifest = JSON.parse(Buffer.from(data.get('manifest.json')!).toString());
    const requested: string[] = [];
    const read: BundleRead = async path => {
      requested.push(path);
      return data.get(path) ?? Buffer.alloc(0);
    };
    const sha256 = 'a'.repeat(64);
    for (const path of ['files/../escape', '../escape', 'collections/x.jsonl']) {
      manifest.files = [{ path, bytes: 0, sha256 }];
      data.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
      await expect(readExportBundle(read)).rejects.toThrow('Invalid external file entry');
    }
    expect(requested.every(path => path === 'manifest.json')).toBe(true);
  });

  it('rejects duplicate notebook ids on write and on read', async () => {
    const { data, write, read } = memoryBundle();
    await expect(createNotebookBundle([notebook, notebook], write)).rejects.toThrow('Duplicate notebook: nb-1');
    const { chatHistory: _c, knowledge: _k, artifacts: _a, tools: _t, agents: _g, ...record } = notebook;
    await createExportBundle(
      {
        collections: {
          notebooks: [record, record],
          'chat-messages': [],
          knowledge: [],
          artifacts: [],
          tools: [],
          agents: [],
        },
      },
      write
    );
    expect(data.has('manifest.json')).toBe(true);
    await expect(readNotebookBundle(read)).rejects.toThrow('Duplicate notebook: nb-1');
  });

  it('keeps a contentUrl-only knowledge record as a reference', async () => {
    const { write, read } = memoryBundle();
    const { content: _content, ...file } = notebook.knowledge[0];
    const source = {
      ...notebook,
      chatHistory: [],
      knowledge: [{ ...file, contentUrl: 'https://example.com/hello.txt' }],
    };
    const manifest = await createNotebookBundle([source], write);
    expect(manifest.files).toEqual([]);
    expect((await readNotebookBundle(read)).notebooks[0].knowledge).toEqual(source.knowledge);
  });

  it('leaves empty image strings inline and round-trips base64-shaped keys unchanged', async () => {
    const { write, read } = memoryBundle();
    const source = {
      ...notebook,
      knowledge: [],
      chatHistory: [{ ...notebook.chatHistory[0], images: ['', 'abcd1234'] }],
    };
    const manifest = await createNotebookBundle([source], write);
    expect(manifest.files).toHaveLength(1);
    expect((await readNotebookBundle(read)).notebooks[0].chatHistory[0].images).toEqual(['', 'abcd1234']);
  });

  it('treats a missing child collection as empty', async () => {
    const { data, write, read } = memoryBundle();
    await createNotebookBundle([{ ...notebook, knowledge: [] }], write);
    const manifest = JSON.parse(Buffer.from(data.get('manifest.json')!).toString());
    delete manifest.collections.tools;
    delete manifest.collections.agents;
    data.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    const [restored] = (await readNotebookBundle(read)).notebooks;
    expect(restored.tools).toEqual([]);
    expect(restored.agents).toEqual([]);
    expect(restored.chatHistory).toHaveLength(1);
  });

  it('rejects manifest keys and timestamps the published schema forbids', async () => {
    const { data, write, read } = memoryBundle();
    await createExportBundle({ collections: {} }, write);
    const manifest = JSON.parse(Buffer.from(data.get('manifest.json')!).toString());
    data.set('manifest.json', Buffer.from(JSON.stringify({ ...manifest, extra: true })));
    await expect(readExportBundle(read)).rejects.toThrow('Invalid bundle manifest');
    data.set('manifest.json', Buffer.from(JSON.stringify({ ...manifest, exportedAt: '2026' })));
    await expect(readExportBundle(read)).rejects.toThrow('Invalid bundle manifest');
  });

  it('rejects image objects without a contentPath', async () => {
    const { data, write, read } = memoryBundle();
    await createNotebookBundle([{ ...notebook, knowledge: [] }], write);
    const manifest = JSON.parse(Buffer.from(data.get('manifest.json')!).toString());
    const row = JSON.parse(Buffer.from(data.get('collections/chat-messages.jsonl')!).toString());
    const broken = Buffer.from(`${JSON.stringify({ ...row, images: [{ url: 'x' }] })}\n`);
    data.set('collections/chat-messages.jsonl', broken);
    manifest.collections['chat-messages'].bytes = broken.length;
    manifest.collections['chat-messages'].sha256 = createHash('sha256').update(broken).digest('hex');
    data.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    await expect(readNotebookBundle(read)).rejects.toThrow('Invalid image entry');
  });
});
