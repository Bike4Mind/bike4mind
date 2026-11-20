import { createHash, randomBytes } from 'node:crypto';
import { appendFile, chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DownloadVerificationError,
  HubAccessError,
  LocalRuntimeError,
  ModelFileBusyError,
  ModelNotFoundError,
  RuntimeConnectionError,
  RuntimeHttpError,
  RuntimeProtocolError,
  RuntimeStorageError,
} from './errors';
import { lockFile } from './fileLock';
import { HuggingFaceHub, type HubGgufFile } from './huggingface';
import type { PullProgress } from './types';
import { startFakeServer, type FakeServer, type Handler, type RecordedRequest } from './__test__/fakeServer';

const TOKEN = 'hf_TestTokenThatMustNeverLeak0123456789';
const REPO = 'acme/tiny-GGUF';
const COMMIT = 'a'.repeat(40);
const BYTES = randomBytes(256 * 1024);
const SHA = createHash('sha256').update(BYTES).digest('hex');
const FILE_PATH = 'tiny-Q4_K_M.gguf';

const servers: FakeServer[] = [];
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'download-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
});

async function serve(routes: Record<string, Handler>): Promise<FakeServer> {
  const server = await startFakeServer(routes);
  servers.push(server);
  return server;
}

/** Serves `body` with Range support; `cut` stops after that many bytes, leaving the socket open or closing it. */
function blob(body: Buffer, options: { ignoreRange?: boolean; cut?: { at: number; then: 'hang' | 'end' } } = {}) {
  return (request: RecordedRequest, response: ServerResponse) => {
    const range = /^bytes=(\d+)-$/.exec(String(request.headers.range ?? ''));
    const start = range && !options.ignoreRange ? Number(range[1]) : 0;
    if (start >= body.length && range) {
      response.writeHead(416, { 'content-range': `bytes */${body.length}` });
      return response.end();
    }
    const headers =
      start > 0
        ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` }
        : ({} as Record<string, string>);
    response.writeHead(start > 0 ? 206 : 200, { 'content-length': String(body.length - start), ...headers });
    const cut = options.cut;
    if (!cut) return response.end(body.subarray(start));
    response.write(body.subarray(start, cut.at), () => {
      if (cut.then === 'end') response.socket?.end();
    });
  };
}

/** A Hub that redirects the resolve URL to a CDN on another origin, as huggingface.co does. */
async function hubWithCdn(cdnHandler: Handler, path = FILE_PATH, body = BYTES) {
  const cdn = await serve({ [`GET /blob/${path}`]: cdnHandler });
  const hub = await serve({
    [`GET /${REPO}/resolve/${COMMIT}/${path}`]: (_request, response) => {
      response.writeHead(302, { location: `${cdn.baseUrl}/blob/${path}?Signature=secret` });
      response.end();
    },
  });
  const client = new HuggingFaceHub({ endpoint: hub.baseUrl, token: TOKEN });
  const file: HubGgufFile = {
    path,
    sizeBytes: body.length,
    sha256: body === BYTES ? SHA : createHash('sha256').update(body).digest('hex'),
    url: client.resolveUrl(REPO, COMMIT, path),
  };
  return { hub, cdn, client, file };
}

function destination(name: string): string {
  return join(dir, `${name}-${randomBytes(4).toString('hex')}.gguf`);
}

/** A partial download as an earlier attempt for the file with `sha256` leaves it. */
async function writePartial(target: string, bytes: Buffer, sha256 = SHA, sizeBytes = BYTES.length): Promise<void> {
  await writeFile(`${target}.partial`, bytes);
  await writeFile(`${target}.partial.json`, JSON.stringify({ sha256, sizeBytes }));
}

describe('HuggingFaceHub.download', () => {
  it('downloads through the CDN redirect, checks the sha256 and sends the token only to the Hub', async () => {
    const { hub, cdn, client, file } = await hubWithCdn(blob(BYTES));
    const target = destination('fresh');
    const progress: PullProgress[] = [];
    const result = await client.download(file, target, { onProgress: event => progress.push(event) });

    expect(result).toEqual({ path: target, sizeBytes: BYTES.length, sha256: SHA, resumedBytes: 0 });
    expect((await readFile(target)).equals(BYTES)).toBe(true);
    await expect(stat(`${target}.partial`)).rejects.toThrow();
    expect(hub.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(cdn.requests[0]?.headers.authorization).toBeUndefined();
    expect(cdn.requests[0]?.headers['accept-encoding']).toBe('identity');
    expect(progress.map(event => event.status)).toEqual(['downloading', 'verifying', 'success']);
    expect(progress.at(-1)).toEqual({ status: 'success', completedBytes: BYTES.length, totalBytes: BYTES.length });
  });

  it('keeps the partial file on cancel and resumes it with a Range request', async () => {
    const half = BYTES.length / 2;
    let served = 0;
    const { cdn, client, file } = await hubWithCdn((request, response) => {
      served++;
      return blob(BYTES, served === 1 ? { cut: { at: half, then: 'hang' } } : {})(request, response);
    });
    const target = destination('resume');
    const controller = new AbortController();
    const pending = client.download(file, target, { signal: controller.signal });
    while (((await stat(`${target}.partial`).catch(() => null))?.size ?? 0) < half)
      await new Promise(r => setTimeout(r, 10));
    const reason = new Error('paused');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    const kept = (await stat(`${target}.partial`)).size;
    expect(kept).toBe(half);

    const progress: PullProgress[] = [];
    const result = await client.download(file, target, { onProgress: event => progress.push(event) });
    expect(result.resumedBytes).toBe(half);
    expect(result.sha256).toBe(SHA);
    expect(cdn.requests[1]?.headers.range).toBe(`bytes=${half}-`);
    expect(progress[0]).toEqual({ status: 'resuming', completedBytes: 0, totalBytes: BYTES.length });
    expect(progress.find(event => event.status === 'downloading')?.completedBytes).toBe(half);
    expect((await readFile(target)).equals(BYTES)).toBe(true);
  });

  it('starts over when the server ignores the range', async () => {
    const { client, file } = await hubWithCdn(blob(BYTES, { ignoreRange: true }));
    const target = destination('ignored');
    await writeFile(`${target}.partial`, BYTES.subarray(0, 1000));
    const result = await client.download(file, target);
    expect(result.resumedBytes).toBe(0);
    expect((await readFile(target)).equals(BYTES)).toBe(true);
  });

  it('refuses a resume answered with a different range', async () => {
    const { client, file } = await hubWithCdn((_request, response) => {
      response.writeHead(206, { 'content-range': `bytes 0-${BYTES.length - 1}/${BYTES.length}` });
      response.end(BYTES);
    });
    const target = destination('wrong-range');
    await writePartial(target, BYTES.subarray(0, 1000));
    await expect(client.download(file, target)).rejects.toBeInstanceOf(RuntimeProtocolError);
  });

  it('starts over once when the range is not satisfiable', async () => {
    const { cdn, client, file } = await hubWithCdn(blob(BYTES));
    const target = destination('unsatisfiable');
    await writePartial(target, Buffer.alloc(BYTES.length), SHA, BYTES.length + 10);
    const shorter = { ...file, sizeBytes: BYTES.length + 10 };
    await expect(client.download(shorter, target)).rejects.toBeInstanceOf(RuntimeConnectionError);
    expect(cdn.requests.map(request => request.headers.range)).toEqual([`bytes=${BYTES.length}-`, undefined]);
  });

  it('starts over when the partial was started for another file', async () => {
    const { cdn, client, file } = await hubWithCdn(blob(BYTES));
    const target = destination('other-revision');
    await writePartial(target, BYTES.subarray(0, 1000), 'b'.repeat(64));
    const result = await client.download(file, target);
    expect(result.resumedBytes).toBe(0);
    expect(cdn.requests.map(request => request.headers.range)).toEqual([undefined]);
    expect((await readFile(target)).equals(BYTES)).toBe(true);
    await expect(stat(`${target}.partial.json`)).rejects.toThrow();

    const unrecorded = destination('unrecorded');
    await writeFile(`${unrecorded}.partial`, BYTES.subarray(0, 1000));
    expect((await client.download(file, unrecorded)).resumedBytes).toBe(0);
  });

  it('keeps a file another download finished while this one waited, and refuses a different one', async () => {
    const { cdn, client, file } = await hubWithCdn(blob(BYTES));
    const target = destination('finished');
    await writeFile(target, BYTES);
    expect(await client.download(file, target)).toEqual({
      path: target,
      sizeBytes: BYTES.length,
      sha256: SHA,
      resumedBytes: 0,
    });
    const other = destination('different');
    await writeFile(other, randomBytes(BYTES.length));
    await expect(client.download(file, other)).rejects.toMatchObject({
      name: 'ModelFileConflictError',
      reason: 'sha256',
    });
    expect(cdn.requests).toHaveLength(0);
  });

  it('trusts the source sidecar of a finished file before hashing it, and drops a record left with no partial', async () => {
    const { cdn, client, file } = await hubWithCdn(blob(BYTES));
    const target = destination('sidecar');
    // Same size, other bytes: only the sidecar can make this pass, so passing shows no hash was taken.
    await writeFile(target, Buffer.alloc(BYTES.length));
    await writeFile(`${target}.source.json`, JSON.stringify({ sha256: SHA.toUpperCase(), sizeBytes: BYTES.length }));
    await writeFile(`${target}.partial.json`, JSON.stringify({ sha256: SHA, sizeBytes: BYTES.length }));
    expect((await client.download(file, target)).sha256).toBe(SHA);
    await expect(stat(`${target}.partial.json`)).rejects.toThrow();
    expect(cdn.requests).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'rides out a lock it cannot read for a moment while writing',
    async () => {
      const mib = 1024 * 1024;
      const body = randomBytes(40 * mib);
      const { client, file } = await hubWithCdn(
        (_request, response) => {
          response.writeHead(200, { 'content-length': String(body.length) });
          let sent = 0;
          const next = () => {
            if (sent >= body.length) return response.end();
            response.write(body.subarray(sent, (sent += mib)));
            setTimeout(next, 5);
          };
          next();
        },
        FILE_PATH,
        body
      );
      const target = destination('unreadable-lock');
      const pending = client.download(file, target);
      const size = async () => (await stat(`${target}.partial`).catch(() => null))?.size ?? 0;
      while ((await size()) < mib) await new Promise(r => setTimeout(r, 1));
      await chmod(`${target}.lock`, 0o000);
      while ((await size()) < 20 * mib) await new Promise(r => setTimeout(r, 1));
      await chmod(`${target}.lock`, 0o644);
      expect((await pending).sha256).toBe(file.sha256);
    }
  );

  it('reads its lock back while writing, so a writer whose lock was taken over stops within 16 MiB', async () => {
    const body = randomBytes(64 * 1024 * 1024);
    const { client, file } = await hubWithCdn(blob(body), FILE_PATH, body);
    const target = destination('taken-over');
    const pending = client.download(file, target).catch((caught: unknown) => caught);
    let at = 0;
    while ((at = (await stat(`${target}.partial`).catch(() => null))?.size ?? 0) < 1024 * 1024)
      await new Promise(r => setTimeout(r, 1));
    const thief = await lockFile(target, 'test', { force: true });
    expect(await pending).toBeInstanceOf(ModelFileBusyError);
    expect((await stat(`${target}.partial`)).size).toBeLessThan(at + 20 * 1024 * 1024);
    await expect(stat(target)).rejects.toThrow();
    await thief.release();
  });

  it('deletes the partial file when the sha256 does not match', async () => {
    const { client, file } = await hubWithCdn(blob(BYTES));
    const target = destination('mismatch');
    const error = await client.download({ ...file, sha256: 'b'.repeat(64) }, target).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DownloadVerificationError);
    expect(error).toMatchObject({ check: 'sha256', expected: 'b'.repeat(64), actual: SHA });
    await expect(stat(`${target}.partial`)).rejects.toThrow();
    await expect(stat(target)).rejects.toThrow();
  });

  it('fails the size check when the server sends more than the listed size', async () => {
    const { client, file } = await hubWithCdn(blob(BYTES));
    const target = destination('oversize');
    const error = await client.download({ ...file, sizeBytes: 1000, sha256: null }, target).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'DownloadVerificationError', check: 'size' });
    await expect(stat(`${target}.partial`)).rejects.toThrow();
  });

  it('checks only the size when the Hub publishes no hash', async () => {
    const { client, file } = await hubWithCdn(blob(BYTES));
    const result = await client.download({ ...file, sha256: null }, destination('nohash'));
    expect(result.sha256).toBeNull();
    expect(result.sizeBytes).toBe(BYTES.length);
  });

  it('starts over instead of resuming bytes it cannot check when the Hub publishes no hash', async () => {
    const { cdn, client, file } = await hubWithCdn(blob(BYTES));
    const target = destination('nohash-resume');
    await writeFile(`${target}.partial`, Buffer.alloc(1000, 7));
    const result = await client.download({ ...file, sha256: null }, target);
    expect(result.resumedBytes).toBe(0);
    expect(cdn.requests[0]?.headers.range).toBeUndefined();
    expect((await readFile(target)).equals(BYTES)).toBe(true);
  });

  it('lets one download at a time write a file and refuses the second as busy', async () => {
    const half = BYTES.length / 2;
    let release: () => void = () => undefined;
    const gate = new Promise<void>(done => (release = done));
    const { cdn, client, file } = await hubWithCdn((_request, response) => {
      response.writeHead(200, { 'content-length': String(BYTES.length) });
      response.write(BYTES.subarray(0, half), () => void gate.then(() => response.end(BYTES.subarray(half))));
    });
    const target = destination('concurrent');
    const first = client.download(file, target);
    while (((await stat(`${target}.partial`).catch(() => null))?.size ?? 0) < half)
      await new Promise(r => setTimeout(r, 10));
    const second = await client.download(file, target).catch((caught: unknown) => caught);
    expect(second).toBeInstanceOf(ModelFileBusyError);
    expect(second).toMatchObject({ pid: process.pid, path: target });
    release();
    expect((await first).sha256).toBe(SHA);
    expect(cdn.requests).toHaveLength(1);
    expect((await readFile(target)).equals(BYTES)).toBe(true);
    await expect(stat(`${target}.lock`)).rejects.toThrow();
  });

  it('fails the size check when the file on disk grew behind its back', async () => {
    const half = BYTES.length / 2;
    let release: () => void = () => undefined;
    const gate = new Promise<void>(done => (release = done));
    const { client, file } = await hubWithCdn((_request, response) => {
      response.writeHead(200, { 'content-length': String(BYTES.length) });
      response.write(BYTES.subarray(0, half), () => void gate.then(() => response.end(BYTES.subarray(half))));
    });
    const target = destination('grown');
    const pending = client.download(file, target).catch((caught: unknown) => caught);
    while (((await stat(`${target}.partial`).catch(() => null))?.size ?? 0) < half)
      await new Promise(r => setTimeout(r, 10));
    // Past the end, where the download's own positioned writes will not cover it.
    await appendFile(`${target}.partial`, Buffer.alloc(BYTES.length));
    release();
    expect(await pending).toMatchObject({
      name: 'DownloadVerificationError',
      check: 'size',
      expected: String(BYTES.length),
      actual: String(half + BYTES.length),
    });
    await expect(stat(target)).rejects.toThrow();
  });

  it('reports file errors as RuntimeStorageError with the errno code', async () => {
    const { client, file } = await hubWithCdn(blob(BYTES));
    const target = join(dir, 'no-such-dir', 'x.gguf');
    const error = await client.download(file, target).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeStorageError);
    expect(error).toMatchObject({ code: 'ENOENT', path: `${target}.lock` });
  });

  it('keeps what arrived when the connection drops early', async () => {
    const { client, file } = await hubWithCdn(blob(BYTES, { cut: { at: 4096, then: 'end' } }));
    const target = destination('dropped');
    await expect(client.download(file, target)).rejects.toBeInstanceOf(RuntimeConnectionError);
    expect((await stat(`${target}.partial`)).size).toBeGreaterThan(0);
  });

  it('fails when the server goes quiet past the idle timeout', async () => {
    const { client, file } = await hubWithCdn(blob(BYTES, { cut: { at: 4096, then: 'hang' } }));
    const error = await client.download(file, destination('idle'), { idleTimeoutMs: 200 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LocalRuntimeError);
    expect((error as Error).message).toMatch(/sent nothing for 200ms while downloading/);
  });

  it('maps Hub refusals to typed errors and keeps CDN query strings out of messages', async () => {
    const gatedHub = await serve({
      [`GET /${REPO}/resolve/${COMMIT}/${FILE_PATH}`]: (_request, response) => {
        response.writeHead(403, {
          'x-error-code': 'GatedRepo',
          'x-error-message': 'Access to this repo is restricted',
        });
        response.end();
      },
    });
    const gated = new HuggingFaceHub({ endpoint: gatedHub.baseUrl, token: TOKEN });
    const file = (client: HuggingFaceHub, path = FILE_PATH): HubGgufFile => ({
      path,
      sizeBytes: 1,
      sha256: null,
      url: client.resolveUrl(REPO, COMMIT, path),
    });
    await expect(gated.download(file(gated), destination('gated'))).rejects.toBeInstanceOf(HubAccessError);
    await expect(gated.download(file(gated, 'missing.gguf'), destination('missing'))).rejects.toBeInstanceOf(
      ModelNotFoundError
    );

    const { client, file: cdnFile } = await hubWithCdn((_request, response) => {
      response.writeHead(403);
      response.end('expired');
    });
    const error = await client.download(cdnFile, destination('expired')).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeHttpError);
    expect(error).toMatchObject({ status: 403 });
    expect((error as Error).message).not.toContain('Signature');
  });

  it('refuses a redirect to a scheme it will not follow', async () => {
    const hub = await serve({
      [`GET /${REPO}/resolve/${COMMIT}/${FILE_PATH}`]: (_request, response) => {
        response.writeHead(302, { location: 'file:///etc/passwd' });
        response.end();
      },
    });
    const client = new HuggingFaceHub({ endpoint: hub.baseUrl });
    const file = { path: FILE_PATH, sizeBytes: 1, sha256: null, url: client.resolveUrl(REPO, COMMIT, FILE_PATH) };
    await expect(client.download(file, destination('scheme'))).rejects.toBeInstanceOf(RuntimeProtocolError);
  });
});
