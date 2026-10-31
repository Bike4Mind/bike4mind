import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';

// Track the real temp input files createTempFile produces so the cleanup
// assertions can verify they are removed after the response.
const tempFiles: string[] = [];
const outputPaths: string[] = [];
const ZIP_BYTES = Buffer.from('PK\x03\x04ZIPDATA');

// Evaluated once at import - not reset in beforeEach - so it captures the options this module's
// top-level baseApi(...) call was made with.
const h = vi.hoisted(() => ({
  baseApiOptions: undefined as unknown,
  getSignedUrl: vi.fn(async (p: string) => `https://signed.example/${p}`),
  getSettingsMap: vi.fn(async (): Promise<Record<string, string>> => ({})),
}));

// baseApi wraps the handler; mock it as a thin pass-through so the test
// focuses on the response body + cleanup behaviour, capturing the options for the scope-gate test.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions = options;
    return { get: (handler: unknown) => handler };
  },
}));

// The REAL accessibleBy plus the REAL defineAbilitiesFor: stubbing accessibleBy is how this suite
// used to pass while production zipped an empty archive (no builder granted `export` on FabFile).
// The share arm is the real implementation - it takes the resource list as a parameter, so it
// registers rules against the stub classes below and CASL still matches them.
vi.mock('@bike4mind/database', async () => ({
  applySharedShareableRules: (
    await vi.importActual<typeof import('../../../../../../packages/database/src/utils/ability')>(
      '../../../../../../packages/database/src/utils/ability'
    )
  ).applySharedShareableRules,
  AdminSettings: class AdminSettings {},
  adminSettingsRepository: {},
  CounterLog: class CounterLog {},
  Session: class Session {
    static find() {
      return { select: () => [] };
    }
  },
  User: class User {},
  Invite: class Invite {},
  Prompt: class Prompt {},
  UserActivityCounter: class UserActivityCounter {},
  FeedbackModel: class FeedbackModel {},
  ModalModel: class ModalModel {},
  Organization: class Organization {},
  FabFile: class FabFile {
    static find = vi.fn();
  },
  Memento: class Memento {},
  Project: class Project {},
  QuestMasterPlan: class QuestMasterPlan {},
}));

vi.mock('@bike4mind/database/infra', () => ({
  SecretRotation: class SecretRotation {},
}));

vi.mock('@server/models/Subscription', () => ({
  Subscription: class Subscription {},
}));

// The admin settings map comes from the DB; the rest of @bike4mind/utils stays real.
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: h.getSettingsMap,
}));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getSignedUrl: h.getSignedUrl }),
}));

// Mirrors the real extractor's contract: a missing URL or a fetch failure only surfaces when the
// caller asks for strict; otherwise it resolves to '' and the route would zip a 0-byte entry.
// No getMaxContentLength here on purpose: it fetches settings through the browser API client, which
// throws Invalid URL in Node. Vitest fails on the missing export if the route imports it again.
vi.mock('@client/app/utils/fabFileUtils', () => ({
  MAX_CONTENT_LENGTH: 50000,
  getContentFromFabfile: vi.fn(async ({ fileUrl, strict }: { fileUrl?: string; strict?: boolean }) => {
    if (!fileUrl || fileUrl.includes('/unreadable/')) {
      if (strict) throw new Error('Failed to fetch file content');
      return '';
    }
    return 'file-content';
  }),
}));

vi.mock('@server/utils/files', () => ({
  createTempFile: vi.fn(async (name: string, _content: string, dir: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, 'file-content');
    tempFiles.push(p);
    return p;
  }),
  // Write real bytes to the output path so the handler reads them back.
  zipFiles: vi.fn(async (_files: string[], out: string) => {
    outputPaths.push(out);
    fs.writeFileSync(out, ZIP_BYTES);
  }),
}));

import handlerImpl from '../download';
// The mock reduces baseApi to a pass-through; cast to avoid express/NextApiRequest mismatch in tests.
const handler = handlerImpl as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
import { FabFile } from '@bike4mind/database';
import { createTempFile, zipFiles } from '@server/utils/files';
import { getContentFromFabfile } from '@client/app/utils/fabFileUtils';
import defineAbilitiesFor from '@server/auth/ability';
import type { IUserDocument } from '@bike4mind/common';

const makeUser = (overrides: Partial<IUserDocument> = {}): IUserDocument =>
  ({ id: 'u1', isAdmin: false, tags: [], groups: [], email: 'user@example.com', ...overrides }) as IUserDocument;

// baseApi always installs req.logger before the handler runs; the skipped-file path logs through it.
const reqWithAbility = (overrides: Partial<IUserDocument> = {}) =>
  ({
    method: 'GET',
    ability: defineAbilitiesFor(makeUser(overrides)),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }) as unknown as NextApiRequest;

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

const oneFile = [{ fileUrl: 'u1', mimeType: 'text/plain', fileName: 'a.txt', moderationStatus: 'clean' }];

describe('GET /api/files/download', () => {
  beforeEach(() => {
    tempFiles.length = 0;
    outputPaths.length = 0;
    vi.clearAllMocks();
  });

  it('responds with the zip bytes (not the path string) and cleans up temp files', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue([
      // isImageServeable gates on moderationStatus alone now (even non-images), so these
      // fixtures need an explicit 'clean' to be zipped - not exercising the gate itself
      // here, that's covered by the next test.
      { fileUrl: 'u1', mimeType: 'text/plain', fileName: 'a.txt', moderationStatus: 'clean' },
      { fileUrl: 'u2', mimeType: 'text/plain', fileName: 'b.txt', moderationStatus: 'clean' },
    ]);

    const req = reqWithAbility();
    const { res, headers, getSent } = makeRes();
    await handler(req, res);

    const body = getSent();
    // Regression guard: body must be the zip BYTES, never the path string.
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body).toEqual(ZIP_BYTES);
    expect(body).not.toBe(outputPaths[0]);
    expect(headers['Content-Type']).toBe('application/zip');

    // Cleanup must run after the response: inputs + output zip gone.
    expect(tempFiles.length).toBe(2);
    for (const f of tempFiles) expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(outputPaths[0])).toBe(false);
    expect(fs.existsSync(path.dirname(outputPaths[0]))).toBe(false);
  });

  it('uses a separate temp directory per request', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue(oneFile);

    for (let i = 0; i < 2; i++) {
      const { res } = makeRes();
      await handler(reqWithAbility(), res);
    }

    expect(outputPaths).toHaveLength(2);
    expect(outputPaths[0]).not.toBe(outputPaths[1]);
    expect(path.dirname(outputPaths[0])).not.toBe(path.dirname(outputPaths[1]));
    expect(path.dirname(outputPaths[0]).startsWith(path.join(os.tmpdir(), 'knowledges-'))).toBe(true);
  });

  it('keeps entries with the same file name separate within a request', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue([...oneFile, ...oneFile]);

    const { res } = makeRes();
    await handler(reqWithAbility(), res);

    expect(tempFiles).toHaveLength(2);
    expect(new Set(tempFiles).size).toBe(2);
  });

  it('keeps entries whose names share a basename separate', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...oneFile[0], fileName: 'x/a.txt' },
      { ...oneFile[0], fileName: 'y/a.txt' },
    ]);

    const { res } = makeRes();
    await handler(reqWithAbility(), res);

    expect(tempFiles.map(f => path.basename(f))).toEqual(['0_a.txt', '1_a.txt']);
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

    const req = reqWithAbility();
    const { res } = makeRes();
    await handler(req, res);

    // Only the clean non-image and the clean image are zipped; held/blocked images and the
    // not-yet-cleared non-image are skipped. Every skip is named in the archive README.
    expect(tempFiles.map(f => path.basename(f))).toEqual(['0_a.txt', '1_clean.png', '2_README.txt']);
    expect(createTempFile).toHaveBeenLastCalledWith(
      '2_README.txt',
      expect.stringContaining('mid-scan.txt: left out, the file was still being scanned or was blocked.'),
      expect.any(String)
    );
  });

  it('exports a file with a 255-character name by capping the temp entry name', async () => {
    const fileName = `${'a'.repeat(251)}.pdf`;
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue([
      { fileUrl: 'u1', mimeType: 'application/pdf', fileName, moderationStatus: 'clean' },
    ]);

    const { res, getSent } = makeRes();
    await handler(reqWithAbility(), res);

    const name = path.basename(tempFiles[0]);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
    expect(name.startsWith('0_')).toBe(true);
    expect(name.endsWith('.txt')).toBe(true);
    expect(getSent()).toEqual(ZIP_BYTES);
  });

  it('leaves out files once the export size budget is reached and names them in the README', async () => {
    const rows = Array.from({ length: 81 }, (_, i) => ({
      fileUrl: `u${i}`,
      mimeType: 'text/plain',
      fileName: `f${i}.txt`,
      moderationStatus: 'clean',
    }));
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
    for (let i = 0; i < 81; i++) {
      (getContentFromFabfile as ReturnType<typeof vi.fn>).mockResolvedValueOnce('x'.repeat(50000));
    }

    const { res } = makeRes();
    await handler(reqWithAbility(), res);

    const names = tempFiles.map(f => path.basename(f));
    expect(names).toContain('79_f79.txt');
    expect(names.some(n => n.endsWith('_f80.txt'))).toBe(false);
    expect(createTempFile).toHaveBeenLastCalledWith(
      '80_README.txt',
      expect.stringContaining('f80.txt: left out, the export reached its size limit.'),
      expect.any(String)
    );
  });

  it('exports more files than one batch, passing each extracted content through', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => ({
        fileUrl: `u${i}`,
        mimeType: 'text/plain',
        fileName: `f${i}.txt`,
        moderationStatus: 'clean',
      }))
    );

    const { res } = makeRes();
    await handler(reqWithAbility(), res);

    expect(tempFiles.map(f => path.basename(f))).toEqual(Array.from({ length: 7 }, (_, i) => `${i}_f${i}.txt`));
    for (let i = 0; i < 7; i++) {
      expect(createTempFile).toHaveBeenCalledWith(`${i}_f${i}.txt`, 'file-content', expect.any(String));
    }
  });

  it('cleans up temp files even when zipping fails', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue([
      { fileUrl: 'u1', mimeType: 'text/plain', fileName: 'a.txt', moderationStatus: 'clean' },
    ]);
    (zipFiles as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

    const req = reqWithAbility();
    const { res } = makeRes();
    await expect(handler(req, res)).rejects.toThrow('boom');

    expect(tempFiles.length).toBe(1);
    for (const f of tempFiles) expect(fs.existsSync(f)).toBe(false);
  });

  it('removes the temp directory after a failure', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue(oneFile);
    (zipFiles as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

    const { res } = makeRes();
    await expect(handler(reqWithAbility(), res)).rejects.toThrow('boom');

    expect(fs.existsSync(path.dirname(tempFiles[0]))).toBe(false);
  });

  // The regression this suite missed until now: the route selects its files with the `export`
  // action, so a builder with no export rule yields CASL's unsatisfiable filter, `find` returns
  // nothing, and the archive is empty. Asserting only "a zip came back" cannot see that.
  it("selects the caller's own files through the real ability and zips them", async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue([
      { fileUrl: 'u1', mimeType: 'text/plain', fileName: 'a.txt', moderationStatus: 'clean' },
      { fileUrl: 'u2', mimeType: 'text/plain', fileName: 'b.txt', moderationStatus: 'clean' },
    ]);

    const { res, getSent } = makeRes();
    await handler(reqWithAbility(), res);

    expect(FabFile.find).toHaveBeenCalledWith({ $or: [{ userId: 'u1' }] });
    expect(tempFiles.length).toBe(2);
    expect(zipFiles).toHaveBeenCalledTimes(1);
    expect((zipFiles as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(tempFiles);
    expect(getSent()).toEqual(ZIP_BYTES);
  });

  it('scopes the export to the caller even for an admin (no org-wide export)', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await handler(reqWithAbility({ isAdmin: true }), makeRes().res);

    expect(FabFile.find).toHaveBeenCalledWith({ $or: [{ userId: 'u1' }] });
  });

  // Client uploads store no fileUrl at all, and a stored one expires an hour after it was
  // minted, so the export must sign the durable object key itself.
  it('signs a fresh URL from filePath when the row has no stored fileUrl', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue([
      { filePath: 'uploads/u1/a.txt', mimeType: 'text/plain', fileName: 'a.txt', moderationStatus: 'clean' },
    ]);

    const { res } = makeRes();
    await handler(reqWithAbility(), res);

    // No `audience: 'browser'`: that signs against S3_PRESIGN_ENDPOINT, which a self-host app
    // container cannot reach, so the server-side fetch would fail and export nothing.
    expect(h.getSignedUrl).toHaveBeenCalledWith('uploads/u1/a.txt', 'get');
    expect(getContentFromFabfile).toHaveBeenCalledWith({
      fileUrl: 'https://signed.example/uploads/u1/a.txt',
      mimeType: 'text/plain',
      strict: true,
      maxContentLength: 50000,
    });
    expect(createTempFile).toHaveBeenCalledTimes(1);
    expect(tempFiles.length).toBe(1);
  });

  // A row can carry both: a list read mints and stores a presigned URL that is dead an hour
  // later, so the freshly signed URL must win over whatever is stored.
  it('prefers a freshly signed URL over a stored, stale fileUrl', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        filePath: 'uploads/u1/a.txt',
        fileUrl: 'https://stale.example/uploads/u1/a.txt?X-Amz-Expires=3600',
        mimeType: 'text/plain',
        fileName: 'a.txt',
        moderationStatus: 'clean',
      },
    ]);

    const { res } = makeRes();
    await handler(reqWithAbility(), res);

    expect(h.getSignedUrl).toHaveBeenCalledWith('uploads/u1/a.txt', 'get');
    expect(getContentFromFabfile).toHaveBeenCalledWith({
      fileUrl: 'https://signed.example/uploads/u1/a.txt',
      mimeType: 'text/plain',
      strict: true,
      maxContentLength: 50000,
    });
    expect(tempFiles.length).toBe(1);
  });

  // Signing is a per-file failure like any other. It sits inside the same try as the fetch, so a
  // bad object key costs that one file rather than rejecting the handler and 500ing the export.
  it('skips a file whose URL cannot be signed and still zips the readable one', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue([
      { filePath: 'broken/a.txt', mimeType: 'text/plain', fileName: 'a.txt', moderationStatus: 'clean' },
      { filePath: 'ok/b.txt', mimeType: 'text/plain', fileName: 'b.txt', moderationStatus: 'clean' },
    ]);
    h.getSignedUrl.mockRejectedValueOnce(new Error('sign failed'));

    const { res, getSent } = makeRes();
    await handler(reqWithAbility(), res);

    // The unreadable row never reaches the extractor, and never becomes content - it is only
    // named in the README.
    expect(getContentFromFabfile).toHaveBeenCalledTimes(1);
    expect(getContentFromFabfile).toHaveBeenCalledWith({
      fileUrl: 'https://signed.example/ok/b.txt',
      mimeType: 'text/plain',
      strict: true,
      maxContentLength: 50000,
    });
    expect(tempFiles.map(f => path.basename(f))).toEqual(['0_b.txt', '1_README.txt']);
    expect(createTempFile).toHaveBeenLastCalledWith(
      '1_README.txt',
      expect.stringContaining('a.txt: left out, its content could not be read.'),
      expect.any(String)
    );
    expect((zipFiles as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(tempFiles);
    expect(getSent()).toEqual(ZIP_BYTES);
  });

  it('skips a file whose freshly signed URL cannot be read instead of zipping it empty', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue([
      { filePath: 'unreadable/a.txt', mimeType: 'text/plain', fileName: 'a.txt', moderationStatus: 'clean' },
      { filePath: 'ok/b.txt', mimeType: 'text/plain', fileName: 'b.txt', moderationStatus: 'clean' },
    ]);

    const { res } = makeRes();
    await handler(reqWithAbility(), res);

    expect(tempFiles.map(f => path.basename(f))).toEqual(['0_b.txt', '1_README.txt']);
    expect((zipFiles as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(tempFiles);
  });

  it('skips a file that extracts to no text rather than archiving a 0-byte entry', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue([
      { filePath: 'uploads/C1/original.png', mimeType: 'image/png', fileName: 'C1.png', moderationStatus: 'clean' },
    ]);
    (getContentFromFabfile as ReturnType<typeof vi.fn>).mockResolvedValueOnce('');

    const { res } = makeRes();
    await handler(reqWithAbility(), res);

    // The image is not archived as an empty entry - only the README, which names it.
    expect(tempFiles.map(f => path.basename(f))).toEqual(['0_README.txt']);
    expect(createTempFile).toHaveBeenCalledWith(
      '0_README.txt',
      expect.stringContaining('C1.png: left out, it contains no extractable text.'),
      expect.any(String)
    );
  });

  // The archive is extracted text: a PDF arrives in it as text, so its name must say so, and a
  // shortened document must be recorded rather than looking complete.
  it('renames a converted document to .txt and records the shortening in README.txt', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue([
      { fileUrl: 'u1', mimeType: 'application/pdf', fileName: 'contract.pdf', moderationStatus: 'clean' },
    ]);
    (getContentFromFabfile as ReturnType<typeof vi.fn>).mockResolvedValueOnce('x'.repeat(50001));

    const { res } = makeRes();
    await handler(reqWithAbility(), res);

    expect(tempFiles.map(f => path.basename(f))).toEqual(['0_contract.pdf.txt', '1_README.txt']);
    expect(createTempFile).toHaveBeenLastCalledWith(
      '1_README.txt',
      expect.stringContaining('contract.pdf: shortened to the first 50000 characters.'),
      expect.any(String)
    );
  });

  it('records a file cut to exactly the cap with no ellipsis (cut ended in } or ])', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue([
      { fileUrl: 'u1', mimeType: 'application/json', fileName: 'data.json', moderationStatus: 'clean' },
    ]);
    (getContentFromFabfile as ReturnType<typeof vi.fn>).mockResolvedValueOnce('x'.repeat(49999) + '}');

    const { res } = makeRes();
    await handler(reqWithAbility(), res);

    expect(tempFiles.map(f => path.basename(f))).toEqual(['0_data.json', '1_README.txt']);
    expect(createTempFile).toHaveBeenLastCalledWith(
      '1_README.txt',
      expect.stringContaining('data.json: shortened to the first 50000 characters.'),
      expect.any(String)
    );
  });

  it('caps extraction at the admin MaxContentLength read on the server', async () => {
    h.getSettingsMap.mockResolvedValueOnce({ MaxContentLength: '100' });
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue(oneFile);
    (getContentFromFabfile as ReturnType<typeof vi.fn>).mockResolvedValueOnce('x'.repeat(100));

    const { res } = makeRes();
    await handler(reqWithAbility(), res);

    expect(getContentFromFabfile).toHaveBeenCalledWith(expect.objectContaining({ maxContentLength: 100 }));
    expect(createTempFile).toHaveBeenLastCalledWith(
      '1_README.txt',
      expect.stringContaining('a.txt: shortened to the first 100 characters.'),
      expect.any(String)
    );
  });

  it('keeps the original name for a file that is already text', async () => {
    (FabFile.find as ReturnType<typeof vi.fn>).mockResolvedValue([
      { fileUrl: 'u1', mimeType: 'text/markdown', fileName: 'notes.md', moderationStatus: 'clean' },
    ]);

    const { res } = makeRes();
    await handler(reqWithAbility(), res);

    // Nothing was left out or shortened, so no README is added either.
    expect(tempFiles.map(f => path.basename(f))).toEqual(['0_notes.md']);
  });

  it('requires files:read at the baseApi route gate', () => {
    expect(h.baseApiOptions).toEqual({ requiredScopes: ['files:read'] });
  });
});
