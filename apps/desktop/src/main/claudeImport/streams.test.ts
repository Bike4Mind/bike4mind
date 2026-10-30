import { mkdtemp, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { buildZip } from './__fixtures__/buildZip';
import { streamJsonArray } from './jsonArrayStream';
import { readHeadAndTail, readJsonlLines } from './jsonlLines';

const readFailure = vi.hoisted(() => ({ next: null as Error | null }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    createReadStream: (...args: Parameters<typeof fs.createReadStream>) => {
      const error = readFailure.next;
      if (!error) return fs.createReadStream(...args);
      readFailure.next = null;
      return new Readable({
        read() {
          this.destroy(error);
        },
      });
    },
  };
});
import { isUnsafeMemberName, listZipMembers, readZipMember, ZipError } from './zipReader';

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

async function* chunked(text: string, size: number): AsyncGenerator<Buffer> {
  const bytes = Buffer.from(text, 'utf8');
  for (let index = 0; index < bytes.length; index += size) yield bytes.subarray(index, index + size);
}

describe('readJsonlLines', () => {
  it('yields complete lines, leaves an unterminated last line, and resumes from an offset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jsonl-'));
    const path = join(dir, 'a.jsonl');
    await writeFile(path, '{"a":1}\n{"b":"\u00e9"}\n{"partial":');
    const lines = await collect(readJsonlLines(path, 0, 1024));
    expect(lines.map(line => line.text)).toEqual(['{"a":1}', '{"b":"\u00e9"}']);
    const resumeAt = lines[1].end;
    await writeFile(path, '{"a":1}\n{"b":"\u00e9"}\n{"partial":true}\n');
    const more = await collect(readJsonlLines(path, resumeAt, 1024));
    expect(more.map(line => line.text)).toEqual(['{"partial":true}']);
  });

  it('skips an oversize line without reading it, and keeps going', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jsonl-'));
    const path = join(dir, 'big.jsonl');
    await writeFile(path, `${'x'.repeat(600 * 1024)}\n{"after":1}\n`);
    const lines = await collect(readJsonlLines(path, 0, 1024));
    expect(lines.map(line => line.text)).toEqual([null, '{"after":1}']);
  });

  it.each([
    { cap: 10, length: 10, skipped: false },
    { cap: 10, length: 11, skipped: true },
    { cap: 10, length: 100, skipped: true },
    { cap: 256 * 1024, length: 256 * 1024, skipped: false },
    { cap: 256 * 1024, length: 256 * 1024 + 1, skipped: true },
  ])('checks the final piece before a newline: $cap bytes, $length characters', async ({ cap, length, skipped }) => {
    const directory = await mkdtemp(join(tmpdir(), 'jsonl-cap-'));
    const path = join(directory, 'line.jsonl');
    await writeFile(path, `${'x'.repeat(length)}\n{}\n`);
    const lines = await collect(readJsonlLines(path, 0, cap));
    expect(lines[0].text).toBe(skipped ? null : 'x'.repeat(length));
    expect(lines[1].text).toBe('{}');
    expect(lines[0].end).toBe(length + 1);
  });

  it('reads only the head and tail for indexing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jsonl-'));
    const path = join(dir, 'long.jsonl');
    const body = Array.from({ length: 2000 }, (_, index) => JSON.stringify({ index })).join('\n') + '\n';
    await writeFile(path, body);
    const { head, tail } = await readHeadAndTail(path, Buffer.byteLength(body), 256);
    expect(JSON.parse(head[0])).toEqual({ index: 0 });
    expect(JSON.parse(tail.at(-1)!)).toEqual({ index: 1999 });
    expect(head.length + tail.length).toBeLessThan(100);
  });
});

describe('streamJsonArray', () => {
  it('splits elements across chunk boundaries, through strings, escapes and multi-byte text', async () => {
    const value = [{ a: '[not] {a} "quoted" \\ end', b: '\u00e9\u{1F955}' }, { c: [1, [2]] }, 7, { d: {} }];
    for (const size of [1, 3, 7, 64]) {
      const out = await collect(streamJsonArray(chunked(JSON.stringify(value), size), 1024));
      expect(out).toEqual([value[0], value[1], value[3]]);
    }
  });

  it('reports an oversize element as null and carries on', async () => {
    const value = [{ big: 'y'.repeat(500) }, { small: 1 }];
    const out = await collect(streamJsonArray(chunked(JSON.stringify(value), 16), 100));
    expect(out).toEqual([null, { small: 1 }]);
  });

  it('rejects something that is not an array, and a truncated one', async () => {
    await expect(collect(streamJsonArray(chunked('{"a":1}', 4), 100))).rejects.toThrow(/JSON array/);
    await expect(collect(streamJsonArray(chunked('[{"a":1},{"b"', 4), 100))).rejects.toThrow(/part-way/);
  });
});

describe('zip reader', () => {
  it('lists members and inflates one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zip-'));
    const path = join(dir, 'export.zip');
    await writeFile(
      path,
      buildZip([
        { name: 'users.json', data: Buffer.from('[]') },
        { name: 'conversations.json', data: Buffer.from('[{"a":1}]') },
        { name: 'stored.txt', data: Buffer.from('plain'), stored: true },
      ])
    );
    const members = await listZipMembers(path);
    expect(members.map(member => member.name)).toEqual(['users.json', 'conversations.json', 'stored.txt']);
    const text = Buffer.concat(await collect(readZipMember(path, members[1], 1024))).toString();
    expect(text).toBe('[{"a":1}]');
    expect(Buffer.concat(await collect(readZipMember(path, members[2], 1024))).toString()).toBe('plain');
  });

  it('stops a member that inflates past the limit even when its header lies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zip-'));
    const path = join(dir, 'bomb.zip');
    await writeFile(
      path,
      buildZip([{ name: 'conversations.json', data: Buffer.alloc(200_000, 0x20), claimedSize: 10 }])
    );
    const [member] = await listZipMembers(path);
    await expect(collect(readZipMember(path, member, 50_000))).rejects.toThrow(ZipError);
  });

  it('refuses encrypted members and a member the header says is too big', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zip-'));
    const path = join(dir, 'x.zip');
    await writeFile(
      path,
      buildZip([
        { name: 'a.json', data: Buffer.from('[]'), encrypted: true },
        { name: 'b.json', data: Buffer.alloc(5000) },
      ])
    );
    const [encrypted, big] = await listZipMembers(path);
    await expect(collect(readZipMember(path, encrypted, 1024))).rejects.toThrow(/encrypted/);
    await expect(collect(readZipMember(path, big, 1024))).rejects.toThrow(/limit/);
  });

  it('fails the read, rather than hanging, when the disk errors under an inflating member', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zip-'));
    const path = join(dir, 'export.zip');
    await writeFile(path, buildZip([{ name: 'conversations.json', data: Buffer.from('[{"a":1}]') }]));
    const [member] = await listZipMembers(path);
    readFailure.next = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    await expect(collect(readZipMember(path, member, 1024))).rejects.toThrow(/EIO/);
  });

  it('rejects a file that is not a zip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zip-'));
    const path = join(dir, 'fake.zip');
    await writeFile(path, 'not a zip at all, just text that is long enough');
    await expect(listZipMembers(path)).rejects.toThrow(ZipError);
  });

  it('rejects an oversized central directory before allocating it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zip-'));
    const path = join(dir, 'large-directory.zip');
    const size = 20 * 1024 * 1024;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt32LE(size, 12);
    const file = await open(path, 'w');
    try {
      await file.write(end, 0, end.length, size);
    } finally {
      await file.close();
    }
    await expect(listZipMembers(path)).rejects.toThrow(/central directory is larger/);
  });

  it('flags member names that would escape an extraction folder', () => {
    for (const name of ['../evil.json', 'a/../../b', '/abs.json', 'C:/x.json', 'a\\b.json', '']) {
      expect(isUnsafeMemberName(name)).toBe(true);
    }
    for (const name of ['conversations.json', 'export/conversations.json', 'a..b.json']) {
      expect(isUnsafeMemberName(name)).toBe(false);
    }
  });
});
