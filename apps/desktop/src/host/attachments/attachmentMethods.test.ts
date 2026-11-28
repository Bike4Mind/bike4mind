import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedApiClient, DeviceFlowClient } from '@bike4mind/client-auth';
import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  ATTACHMENT_UPLOAD_IDLE_MS,
  HOST_ERROR_CODES,
  MAX_OPEN_ATTACHMENT_UPLOADS,
  type HostResponse,
} from '@shared/hostProtocol';
import { IMAGE_BYTE_CAP } from '../../main/chat/attachments';
import { composeHeadlessHost, type HeadlessHost } from '../headless/composeHeadlessHost';
import { MAX_UPLOAD_BYTES } from './AttachmentUploads';

// The host runs without Electron; any import of it fails the suite.
vi.mock('electron', () => {
  throw new Error('the headless host loaded electron');
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56, 7)]);

const hosts: HeadlessHost[] = [];
const roots: string[] = [];

beforeEach(() => {
  vi.stubEnv('B4M_DEFAULT_API_URL', 'https://b4m.example.com');
});

afterEach(async () => {
  vi.useRealTimers();
  for (const host of hosts.splice(0)) host.dispose();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function dataDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'host-attachments-'));
  roots.push(root);
  return join(root, 'host');
}

async function compose(directory: string): Promise<HeadlessHost> {
  const host = await composeHeadlessHost({
    dataDirectory: directory,
    homeDirectory: join(dirname(directory), 'home'),
    version: '9.9.9-test',
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    auth: {
      createDeviceFlowClient: () => ({}) as unknown as DeviceFlowClient,
      createApiClient: () => ({ get: vi.fn() }) as unknown as AuthenticatedApiClient,
    },
  });
  hosts.push(host);
  return host;
}

type Client = ReturnType<typeof client>;

function client(host: HeadlessHost) {
  const connection = host.server.connect(() => undefined);
  let nextId = 1;
  const call = (method: string, params?: unknown): Promise<HostResponse> =>
    connection.handle({ jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) });
  const result = async <T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> => {
    const response = await call(method, params);
    if ('error' in response) throw new Error(`${method}: ${response.error.message}`);
    return response.result as T;
  };
  return { call, result, close: () => connection.close() };
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function begin(rpc: Client, sessionId: string, name: string, byteSize: number, mediaType?: string) {
  const { uploadId } = await rpc.result<{ uploadId: string }>('attachment/uploadBegin', {
    sessionId,
    name,
    byteSize,
    ...(mediaType ? { mediaType } : {}),
  });
  return uploadId;
}

async function upload(rpc: Client, sessionId: string, name: string, bytes: Buffer, mediaType?: string) {
  const uploadId = await begin(rpc, sessionId, name, bytes.length, mediaType);
  for (let index = 0; index * ATTACHMENT_UPLOAD_CHUNK_BYTES < bytes.length; index++) {
    const chunk = bytes.subarray(index * ATTACHMENT_UPLOAD_CHUNK_BYTES, (index + 1) * ATTACHMENT_UPLOAD_CHUNK_BYTES);
    await rpc.result('attachment/uploadChunk', { uploadId, index, data: chunk.toString('base64') });
  }
  return rpc.call('attachment/uploadCommit', { uploadId, sha256: sha256(bytes) });
}

function refusal(response: HostResponse) {
  if (!('error' in response)) throw new Error(`expected a refusal, got ${JSON.stringify(response.result)}`);
  expect(response.error.code).toBe(HOST_ERROR_CODES.attachmentRefused);
  return (response.error.data as { reason: string }).reason;
}

const staged = (directory: string) =>
  readdir(join(directory, 'attachments', '.uploads')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });

describe('attachment uploads over the host protocol', () => {
  it('takes a file in through intake and reads it back', async () => {
    const directory = await dataDirectory();
    const rpc = client(await compose(directory));

    const image = await upload(rpc, 'draft-a', 'shot.png', PNG, 'image/png');
    expect(image).toMatchObject({
      result: { attachment: { kind: 'image', mediaType: 'image/png', byteSize: PNG.length } },
    });
    const imageId = (image as { result: { attachment: { id: string } } }).result.attachment.id;
    expect(await rpc.result('attachment/read', { sessionId: 'draft-a', attachmentId: imageId })).toEqual({
      content: `data:image/png;base64,${PNG.toString('base64')}`,
    });

    const text = await upload(rpc, 'draft-a', 'notes.md', Buffer.from('# hello\n'));
    expect(text).toMatchObject({ result: { attachment: { kind: 'text', name: 'notes.md' } } });
    expect(await staged(directory)).toEqual([]);
  });

  it('uses the name only as a label, never as a path', async () => {
    const directory = await dataDirectory();
    const rpc = client(await compose(directory));

    const response = await upload(rpc, 'draft-a', '../../escape.txt', Buffer.from('hi'));
    expect(response).toMatchObject({ result: { attachment: { name: 'escape.txt' } } });
    expect(await readdir(dirname(directory))).not.toContain('escape.txt');
  });

  it('refuses an upload declared over the largest input before any byte is sent', async () => {
    const rpc = client(await compose(await dataDirectory()));
    const response = await rpc.call('attachment/uploadBegin', {
      sessionId: 'draft-a',
      name: 'huge.pdf',
      byteSize: MAX_UPLOAD_BYTES + 1,
    });
    expect(refusal(response)).toBe('tooLarge');
  });

  it('answers an image over the stored cap with intake reason, since this host does not shrink', async () => {
    const directory = await dataDirectory();
    const rpc = client(await compose(directory));
    const big = Buffer.concat([PNG, Buffer.alloc(IMAGE_BYTE_CAP)]);

    const response = await upload(rpc, 'draft-a', 'big.png', big, 'image/png');
    expect(response).toMatchObject({
      result: { rejected: { name: 'big.png', reason: expect.stringContaining('limit') } },
    });
    expect(await staged(directory)).toEqual([]);
  });

  it('refuses a chunk out of order, an oversize chunk and one past the declared size, keeping the upload', async () => {
    const rpc = client(await compose(await dataDirectory()));
    const uploadId = await begin(rpc, 'draft-a', 'a.txt', 4);
    const data = (bytes: number) => Buffer.alloc(bytes, 0x61).toString('base64');

    expect(refusal(await rpc.call('attachment/uploadChunk', { uploadId, index: 1, data: data(2) }))).toBe('outOfOrder');
    expect(
      refusal(
        await rpc.call('attachment/uploadChunk', { uploadId, index: 0, data: data(ATTACHMENT_UPLOAD_CHUNK_BYTES + 1) })
      )
    ).toBe('chunkTooLarge');
    expect(refusal(await rpc.call('attachment/uploadChunk', { uploadId, index: 0, data: data(5) }))).toBe(
      'chunkTooLarge'
    );
    expect(await rpc.result('attachment/uploadChunk', { uploadId, index: 0, data: data(4) })).toEqual({
      receivedBytes: 4,
    });
  });

  it('refuses a commit whose size or hash does not match, and closes the upload', async () => {
    const directory = await dataDirectory();
    const rpc = client(await compose(directory));
    const bytes = Buffer.from('four');

    const short = await begin(rpc, 'draft-a', 'a.txt', 8);
    await rpc.result('attachment/uploadChunk', { uploadId: short, index: 0, data: bytes.toString('base64') });
    expect(refusal(await rpc.call('attachment/uploadCommit', { uploadId: short, sha256: sha256(bytes) }))).toBe(
      'sizeMismatch'
    );

    const wrong = await begin(rpc, 'draft-a', 'a.txt', 4);
    await rpc.result('attachment/uploadChunk', { uploadId: wrong, index: 0, data: bytes.toString('base64') });
    expect(refusal(await rpc.call('attachment/uploadCommit', { uploadId: wrong, sha256: '0'.repeat(64) }))).toBe(
      'hashMismatch'
    );
    expect(refusal(await rpc.call('attachment/uploadChunk', { uploadId: wrong, index: 1, data: 'aGk=' }))).toBe(
      'unknownUpload'
    );
    expect(await staged(directory)).toEqual([]);
  });

  it(`refuses upload number ${MAX_OPEN_ATTACHMENT_UPLOADS + 1} on one connection, not on another`, async () => {
    const host = await compose(await dataDirectory());
    const rpc = client(host);
    const params = { sessionId: 'draft-a', name: 'a.txt', byteSize: 1 };

    const begun = await Promise.all(
      Array.from({ length: MAX_OPEN_ATTACHMENT_UPLOADS + 1 }, () => rpc.call('attachment/uploadBegin', params))
    );
    expect(begun.filter(response => 'result' in response)).toHaveLength(MAX_OPEN_ATTACHMENT_UPLOADS);
    expect(refusal(begun.find(response => 'error' in response)!)).toBe('tooManyUploads');

    expect(await client(host).call('attachment/uploadBegin', params)).toHaveProperty('result');
  });

  it('keeps one connection from touching another connection upload', async () => {
    const host = await compose(await dataDirectory());
    const uploadId = await begin(client(host), 'draft-a', 'a.txt', 1);
    expect(refusal(await client(host).call('attachment/uploadAbort', { uploadId }))).toBe('unknownUpload');
  });

  it('removes what a connection left open when it closes, and what an abort names', async () => {
    const directory = await dataDirectory();
    const host = await compose(directory);
    const rpc = client(host);

    const aborted = await begin(rpc, 'draft-a', 'a.txt', 4);
    await begin(rpc, 'draft-a', 'b.txt', 4);
    expect(await staged(directory)).toHaveLength(2);

    await rpc.result('attachment/uploadAbort', { uploadId: aborted });
    expect(await staged(directory)).toHaveLength(1);

    rpc.close();
    await vi.waitFor(async () => expect(await staged(directory)).toEqual([]));
  });

  it('drops an upload that sees no chunk for the idle time', async () => {
    const directory = await dataDirectory();
    const rpc = client(await compose(directory));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const uploadId = await begin(rpc, 'draft-a', 'a.txt', 4);
    await vi.advanceTimersByTimeAsync(ATTACHMENT_UPLOAD_IDLE_MS - 1);
    await rpc.result('attachment/uploadChunk', { uploadId, index: 0, data: 'aGk=' });
    await vi.advanceTimersByTimeAsync(ATTACHMENT_UPLOAD_IDLE_MS - 1);
    expect(await staged(directory)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(async () => expect(await staged(directory)).toEqual([]));
    expect(refusal(await rpc.call('attachment/uploadChunk', { uploadId, index: 1, data: 'aGk=' }))).toBe(
      'unknownUpload'
    );
  });

  it('clears uploads a previous run left behind when it starts', async () => {
    const directory = await dataDirectory();
    const leftover = join(directory, 'attachments', '.uploads');
    await mkdir(leftover, { recursive: true });
    await writeFile(join(leftover, 'abandoned'), 'half a file');

    const rpc = client(await compose(directory));
    await begin(rpc, 'draft-a', 'a.txt', 1);
    expect(await staged(directory)).not.toContain('abandoned');
  });

  it('copies a draft upload into the session it became, and refuses uploads into a discarded draft', async () => {
    const directory = await dataDirectory();
    const rpc = client(await compose(directory));

    const response = await upload(rpc, 'draft-a', 'a.txt', Buffer.from('carried over'));
    const { id } = (response as { result: { attachment: { id: string } } }).result.attachment;
    const open = await begin(rpc, 'draft-a', 'b.txt', 4);

    await rpc.result('attachment/copyDraft', { draftId: 'draft-a', sessionId: 'session-1', attachmentIds: [id] });
    expect(await rpc.result('attachment/read', { sessionId: 'session-1', attachmentId: id })).toEqual({
      content: 'carried over',
    });

    await rpc.result('attachment/discardDraft', { draftId: 'draft-a' });
    expect(refusal(await rpc.call('attachment/uploadChunk', { uploadId: open, index: 0, data: 'aGk=' }))).toBe(
      'unknownUpload'
    );
    expect(
      refusal(await rpc.call('attachment/uploadBegin', { sessionId: 'draft-a', name: 'c.txt', byteSize: 1 }))
    ).toBe('draftDiscarded');
    expect(await rpc.result('attachment/read', { sessionId: 'session-1', attachmentId: id })).toEqual({
      content: 'carried over',
    });
  });

  it('refuses to read a stored PDF and answers null for an attachment that is gone', async () => {
    const rpc = client(await compose(await dataDirectory()));
    const { makePdf } = await import('../../main/chat/pdfFixtures');

    const response = await upload(rpc, 'draft-a', 'doc.pdf', makePdf(['one page']));
    const { id } = (response as { result: { attachment: { id: string; kind: string } } }).result.attachment;
    expect(refusal(await rpc.call('attachment/read', { sessionId: 'draft-a', attachmentId: id }))).toBe('notReadable');

    await rpc.result('attachment/discard', { sessionId: 'draft-a', attachmentId: id });
    expect(await rpc.result('attachment/read', { sessionId: 'draft-a', attachmentId: id })).toEqual({ content: null });
  });

  it('refuses ids that are not the store id shape', async () => {
    const rpc = client(await compose(await dataDirectory()));
    const response = await rpc.call('attachment/read', { sessionId: '../x', attachmentId: 'a1' });
    expect(response).toMatchObject({ error: { code: HOST_ERROR_CODES.invalidParams } });
    const begun = await rpc.call('attachment/uploadBegin', { sessionId: 'a/b', name: 'a.txt', byteSize: 1 });
    expect(begun).toMatchObject({ error: { code: HOST_ERROR_CODES.invalidParams } });
  });
});
