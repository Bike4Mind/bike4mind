import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { crc32 } from 'zlib';
import { describeImportFailure } from '@bike4mind/common';
import { extractFileFromZip } from './index';

// Minimal stored (uncompressed) zip writer, enough for yauzl to read.
const buildStoredZip = (files: Record<string, string>): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
};

let dir: string;
const writeTmp = (name: string, data: Buffer | string) => {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'extract-zip-test-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('extractFileFromZip', () => {
  it('resolves with the entry contents when the archive has it', async () => {
    const json = JSON.stringify([{ title: 'caf\u00e9 \u2603' }]);
    const zip = writeTmp('with.zip', buildStoredZip({ 'user.json': '{}', 'conversations.json': json }));

    await expect(extractFileFromZip(zip, 'conversations.json')).resolves.toBe(json);
  });

  it('decodes a multi-byte character split across read-stream chunks', async () => {
    // 3-byte characters never align with power-of-two chunk sizes, so some chunk boundary
    // falls inside one whatever the stream's high-water mark is.
    const json = JSON.stringify(['\u2603'.repeat(100_000)]);
    const zip = writeTmp('large.zip', buildStoredZip({ 'conversations.json': json }));

    await expect(extractFileFromZip(zip, 'conversations.json')).resolves.toBe(json);
  });

  it('rejects when the archive ends without the entry', async () => {
    const zip = writeTmp('without.zip', buildStoredZip({ 'user.json': '{}', 'chat.html': '<html/>' }));

    await expect(extractFileFromZip(zip, 'conversations.json')).rejects.toThrow(
      'conversations.json not found in archive'
    );
  });

  it('rejects when the archive is empty', async () => {
    const zip = writeTmp('empty.zip', buildStoredZip({}));

    await expect(extractFileFromZip(zip, 'conversations.json')).rejects.toThrow(
      'conversations.json not found in archive'
    );
  });

  it('rejects when the file is not a zip', async () => {
    const notZip = writeTmp('not-a-zip.zip', 'this is plain text, not an archive');

    await expect(extractFileFromZip(notZip, 'conversations.json')).rejects.toThrow();
  });
});

// Feeds the real rejection text into the shared mapper, so a yauzl wording change cannot
// silently drop these uploads back to the generic "try again later" reason.
describe('extractFileFromZip rejections map to a non-retryable reason', () => {
  const rejectionOf = async (path: string) => {
    const err = await extractFileFromZip(path, 'conversations.json').then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    return describeImportFailure((err as Error).message, 'OpenAI');
  };

  it('a zip holding only user.json', async () => {
    const zip = writeTmp('user-only.zip', buildStoredZip({ 'user.json': '{}' }));

    expect(await rejectionOf(zip)).toEqual({
      reason: "This file doesn't look like a ChatGPT export (no conversations.json).",
      retryable: false,
    });
  });

  it('a text file renamed to .zip', async () => {
    const notZip = writeTmp('renamed.zip', 'plain text renamed to look like an archive');

    expect(await rejectionOf(notZip)).toEqual({ reason: 'This file is not a valid .zip archive.', retryable: false });
  });
});
