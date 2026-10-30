import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { FabFile } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235946_restore-legacy-xls-mime-type';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const XLS = 'application/vnd.ms-excel';
const CFB = 'application/x-cfb';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const seed = async (fileName: string, mimeType: string, extra: Record<string, unknown> = {}) => {
  const _id = new mongoose.Types.ObjectId();
  await FabFile.collection.insertOne({
    _id,
    fileName,
    mimeType,
    status: 'complete',
    chunkCount: 0,
    chunked: false,
    deletedAt: null,
    noExtractableTextAt: new Date(),
    ...extra,
  });
  return _id;
};
const load = (_id: mongoose.Types.ObjectId) => FabFile.collection.findOne({ _id });

describe('restore-legacy-xls-mime-type', () => {
  it('restores unchunked .xls rows stored as x-cfb and clears their stamp and format error, leaving the rest', async () => {
    const xls = await seed('Budget 2003.XLS', CFB);
    const otherCfb = await seed('setup.msi', CFB);
    const failed = await seed('failed.xls', CFB, {
      error:
        'This file format is not supported, so the file was not indexed. Save it as PDF, DOCX, XLSX or PPTX and upload it again.',
    });
    const otherError = await seed('broken.xls', CFB, { error: 'S3 read failed' });
    const chunked = await seed('done.xls', CFB, { chunkCount: 3, chunked: true });
    const deleted = await seed('gone.xls', CFB, { deletedAt: new Date() });
    const realXls = await seed('fine.xls', XLS);

    await migration.up();
    await migration.up();

    expect(await load(xls)).toMatchObject({ mimeType: XLS, noExtractableTextAt: null });
    expect(await load(failed)).toMatchObject({ mimeType: XLS, noExtractableTextAt: null, error: null });
    expect(await load(otherError)).toMatchObject({ mimeType: CFB, error: 'S3 read failed' });
    expect(await load(deleted)).toMatchObject({ mimeType: CFB });
    expect(await load(otherCfb)).toMatchObject({ mimeType: CFB, noExtractableTextAt: expect.any(Date) });
    expect(await load(chunked)).toMatchObject({ mimeType: CFB, noExtractableTextAt: expect.any(Date) });
    expect(await load(realXls)).toMatchObject({ mimeType: XLS, noExtractableTextAt: expect.any(Date) });
  });
});
