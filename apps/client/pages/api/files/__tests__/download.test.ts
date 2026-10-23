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
const h = vi.hoisted(() => ({ baseApiOptions: undefined as unknown }));

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

vi.mock('@client/app/utils/fabFileUtils', () => ({
  getContentFromFabfile: vi.fn(async () => 'file-content'),
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
import { zipFiles } from '@server/utils/files';
import defineAbilitiesFor from '@server/auth/ability';
import type { IUserDocument } from '@bike4mind/common';

const makeUser = (overrides: Partial<IUserDocument> = {}): IUserDocument =>
  ({ id: 'u1', isAdmin: false, tags: [], groups: [], email: 'user@example.com', ...overrides }) as IUserDocument;

const reqWithAbility = (overrides: Partial<IUserDocument> = {}) =>
  ({ method: 'GET', ability: defineAbilitiesFor(makeUser(overrides)) }) as unknown as NextApiRequest;

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
    // not-yet-cleared non-image are skipped.
    expect(tempFiles.length).toBe(2);
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

  it('requires files:read at the baseApi route gate', () => {
    expect(h.baseApiOptions).toEqual({ requiredScopes: ['files:read'] });
  });
});
