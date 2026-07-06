import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';

// Track the real temp input files createTempFile produces so the cleanup
// assertions can verify they are removed after the response.
const tempFiles: string[] = [];
const ZIP_BYTES = Buffer.from('PKZIPDATA');

// baseApi wraps the handler; mock it as a thin pass-through so the test
// focuses on the response body + cleanup behaviour.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ get: (h: unknown) => h }),
}));

vi.mock('@casl/mongoose', () => ({
  accessibleBy: () => ({ ofType: () => ({}) }),
}));

vi.mock('@bike4mind/database', () => ({
  FabFile: { find: vi.fn() },
}));

vi.mock('@client/app/utils/fabFileUtils', () => ({
  getContentFromFabfile: vi.fn(async () => 'file-content'),
}));

vi.mock('@server/utils/files', () => ({
  createTempFile: vi.fn(async (name: string) => {
    const p = path.join(os.tmpdir(), `test_${name}`);
    fs.writeFileSync(p, 'file-content');
    tempFiles.push(p);
    return p;
  }),
  // Write real bytes to the output path so the handler reads them back.
  zipFiles: vi.fn(async (_files: string[], out: string) => {
    fs.writeFileSync(out, ZIP_BYTES);
  }),
}));

import handlerImpl from '../download';
// The mock reduces baseApi to a pass-through; cast to avoid express/NextApiRequest mismatch in tests.
const handler = handlerImpl as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
import { FabFile } from '@bike4mind/database';
import { zipFiles } from '@server/utils/files';

function makeRes() {
  const headers: Record<string, string> = {};
  let sent: unknown;
  const res = {
    statusCode: 200,
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    status(this: { statusCode: number }, code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: unknown) {
      sent = body;
      return this;
    },
  } as unknown as NextApiResponse & { statusCode: number };
  return { res, headers, getSent: () => sent };
}

const outputZipPath = path.join(os.tmpdir(), 'knowledges.zip');

describe('GET /api/files/download', () => {
  beforeEach(() => {
    tempFiles.length = 0;
    vi.clearAllMocks();
    fs.rmSync(outputZipPath, { force: true });
  });

  it('responds with the zip bytes (not the path string) and cleans up temp files', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue([
      // isImageServeable gates on moderationStatus alone now (even non-images), so these
      // fixtures need an explicit 'clean' to be zipped - not exercising the gate itself
      // here, that's covered by the next test.
      { fileUrl: 'u1', mimeType: 'text/plain', fileName: 'a.txt', moderationStatus: 'clean' },
      { fileUrl: 'u2', mimeType: 'text/plain', fileName: 'b.txt', moderationStatus: 'clean' },
    ]);

    const req = { method: 'GET', ability: {} } as unknown as NextApiRequest;
    const { res, headers, getSent } = makeRes();
    await handler(req, res);

    const body = getSent();
    // Regression guard: body must be the zip BYTES, never the path string.
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body).toEqual(ZIP_BYTES);
    expect(body).not.toBe(outputZipPath);
    expect(headers['Content-Type']).toBe('application/zip');

    // Cleanup must run after the response: inputs + output zip gone.
    expect(tempFiles.length).toBe(2);
    for (const f of tempFiles) expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(outputZipPath)).toBe(false);
  });

  it('skips held/blocked uploaded images and a not-yet-cleared non-image, keeps clean files', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue([
      { fileUrl: 'u1', mimeType: 'text/plain', fileName: 'a.txt', moderationStatus: 'clean' },
      { fileUrl: 'u2', mimeType: 'image/png', fileName: 'held.png', moderationStatus: 'pending' },
      { fileUrl: 'u3', mimeType: 'image/png', fileName: 'blocked.png', moderationStatus: 'blocked' },
      { fileUrl: 'u4', mimeType: 'image/png', fileName: 'clean.png', moderationStatus: 'clean' },
      // A non-image with an unset moderationStatus is now held too.
      { fileUrl: 'u5', mimeType: 'text/plain', fileName: 'mid-scan.txt' },
    ]);

    const req = { method: 'GET', ability: {} } as unknown as NextApiRequest;
    const { res } = makeRes();
    await handler(req, res);

    // Only the clean non-image and the clean image are zipped; held/blocked images and the
    // not-yet-cleared non-image are skipped.
    expect(tempFiles.length).toBe(2);
  });

  it('cleans up temp files even when zipping fails', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue([
      { fileUrl: 'u1', mimeType: 'text/plain', fileName: 'a.txt', moderationStatus: 'clean' },
    ]);
    (zipFiles as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

    const req = { method: 'GET', ability: {} } as unknown as NextApiRequest;
    const { res } = makeRes();
    await expect(handler(req, res)).rejects.toThrow('boom');

    expect(tempFiles.length).toBe(1);
    for (const f of tempFiles) expect(fs.existsSync(f)).toBe(false);
  });
});
