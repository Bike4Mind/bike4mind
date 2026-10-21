import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInflateRaw } from 'node:zlib';

/**
 * Just enough of the zip format to pull named members out of a claude.ai data export, as a
 * stream, without extracting anything to disk. Hand-rolled rather than a dependency because the
 * guards are the point: every member is size-checked against what actually inflates, not what
 * the header claims, and names are matched rather than resolved, so nothing in the archive ever
 * becomes a filesystem path.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
const EOCD_SEARCH = EOCD_MIN + 0xffff;
const CENTRAL_HEADER = 46;
const LOCAL_HEADER = 30;
const ZIP64_MARKER = 0xffffffff;
/** Even 65,534 short names fit comfortably; never allocate from an untrusted 32-bit size. */
export const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;

export interface ZipMember {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  encrypted: boolean;
}

export class ZipError extends Error {}

/** A member name that could only be meant to land outside wherever the archive is unpacked. */
export function isUnsafeMemberName(name: string): boolean {
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0')) return true;
  if (/^[A-Za-z]:/.test(name)) return true;
  return name.split('/').some(segment => segment === '..');
}

export async function listZipMembers(path: string): Promise<ZipMember[]> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    if (size < EOCD_MIN) throw new ZipError('not a zip archive');
    const tailLength = Math.min(size, EOCD_SEARCH);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);

    let eocd = -1;
    for (let index = tailLength - EOCD_MIN; index >= 0; index--) {
      if (tail.readUInt32LE(index) === EOCD_SIGNATURE) {
        eocd = index;
        break;
      }
    }
    if (eocd < 0) throw new ZipError('not a zip archive');

    const entries = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (centralSize === ZIP64_MARKER || centralOffset === ZIP64_MARKER || entries === 0xffff) {
      throw new ZipError('zip64 archives are not supported');
    }
    if (centralOffset + centralSize > size) throw new ZipError('zip central directory is out of range');
    if (centralSize > MAX_CENTRAL_DIRECTORY_BYTES)
      throw new ZipError('zip central directory is larger than the import limit');

    const central = Buffer.alloc(centralSize);
    await handle.read(central, 0, centralSize, centralOffset);

    const members: ZipMember[] = [];
    let cursor = 0;
    for (let index = 0; index < entries; index++) {
      if (cursor + CENTRAL_HEADER > central.length || central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
        throw new ZipError('zip central directory is corrupt');
      }
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const localHeaderOffset = central.readUInt32LE(cursor + 42);
      const name = central.toString('utf8', cursor + CENTRAL_HEADER, cursor + CENTRAL_HEADER + nameLength);
      members.push({
        name,
        method,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        encrypted: (flags & 1) === 1,
      });
      cursor += CENTRAL_HEADER + nameLength + extraLength + commentLength;
    }
    return members;
  } finally {
    await handle.close();
  }
}

/**
 * The member's inflated bytes as a stream, failing once more than `maxBytes` come out - the
 * header's own size is a claim, and a bomb lies in it.
 */
export async function* readZipMember(path: string, member: ZipMember, maxBytes: number): AsyncGenerator<Buffer> {
  if (member.encrypted) throw new ZipError(`${member.name} is encrypted`);
  if (member.method !== 0 && member.method !== 8) throw new ZipError(`${member.name} uses an unsupported compression`);
  if (member.uncompressedSize > maxBytes) throw new ZipError(`${member.name} is larger than the import limit`);
  if (member.compressedSize === ZIP64_MARKER || member.uncompressedSize === ZIP64_MARKER) {
    throw new ZipError('zip64 archives are not supported');
  }

  const handle = await open(path, 'r');
  let dataStart: number;
  try {
    const header = Buffer.alloc(LOCAL_HEADER);
    await handle.read(header, 0, LOCAL_HEADER, member.localHeaderOffset);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new ZipError('zip local header is corrupt');
    dataStart = member.localHeaderOffset + LOCAL_HEADER + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }

  if (member.compressedSize === 0) return;
  const raw = createReadStream(path, { start: dataStart, end: dataStart + member.compressedSize - 1 });
  const inflate = member.method === 8 ? createInflateRaw() : null;
  // pipe() does not carry a read error across: unforwarded, it is an uncaught exception in main
  // and the loop below never settles.
  if (inflate) raw.on('error', error => inflate.destroy(error));
  const source = inflate ? raw.pipe(inflate) : raw;
  let total = 0;
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > maxBytes) throw new ZipError(`${member.name} is larger than the import limit`);
      yield chunk;
    }
  } finally {
    raw.destroy();
    inflate?.destroy();
  }
}
