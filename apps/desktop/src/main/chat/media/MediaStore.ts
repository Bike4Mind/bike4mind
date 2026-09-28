import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Private scheme the renderer loads generated media over.
 *
 * Not `file:`: widening the renderer's CSP to `file:` would make every path on the machine
 * loadable from a page the model can put markup into. This scheme resolves ONLY inside the
 * media directory, so an id is the whole addressable space.
 */
export const MEDIA_SCHEME = 'b4m-media';

/** Host component of a media URL. Constant - the session and file live in the path. */
const MEDIA_HOST = 'media';

/**
 * Types we are willing to store, and the extension each is stored under.
 *
 * Doubles as the allow-list: a response whose Content-Type is not here is refused rather than
 * written with a guessed extension, because the extension is what the protocol handler reads
 * the Content-Type back out of.
 */
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/opus': 'opus',
  'audio/ogg': 'opus',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

/** First mime listed for an extension wins, so a stored file reads back as one canonical type. */
const MIME_BY_EXTENSION: Record<string, string> = Object.entries(EXTENSION_BY_MIME).reduce<Record<string, string>>(
  (map, [mime, extension]) => {
    if (!map[extension]) map[extension] = mime;
    return map;
  },
  {}
);

/** Names this store generates, and the only shape its protocol handler will resolve. */
const NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/;

/** Matches SessionStore's ids, which are what the media subdirectories are named after. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Refused above this size. The renderer holds the decoded bytes in memory and the file sits in
 * userData until the conversation is deleted; an image model that returns something this large
 * is a bug in the request, not a picture anyone wants inline.
 */
export const MAX_MEDIA_BYTES = 24 * 1024 * 1024;

export interface StoredMedia {
  /** File name inside the session's media folder, and the last segment of `url`. */
  name: string;
  /** `b4m-media://` URL the renderer loads. */
  url: string;
  mimeType: string;
  byteLength: number;
}

export function mediaUrl(sessionId: string, name: string): string {
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${sessionId}/${name}`;
}

export function isSupportedMediaType(mimeType: string): boolean {
  return normalizeMime(mimeType) in EXTENSION_BY_MIME;
}

/** Strip parameters and case, so `audio/mpeg; charset=binary` matches the table. */
function normalizeMime(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

/**
 * Generated images and audio on disk, one folder per conversation.
 *
 * Lives beside the session files in userData rather than anywhere the user chose: these bytes
 * are the app's own, they are addressed only through {@link MEDIA_SCHEME}, and a conversation
 * that is deleted takes them with it. userData is also in the shell sandbox's protected set, so
 * a granted home folder does not make generated media reachable from a bash tool.
 */
export class MediaStore {
  constructor(private readonly baseDirectory: string) {}

  async save(sessionId: string, bytes: Buffer, mimeType: string): Promise<StoredMedia> {
    const normalized = normalizeMime(mimeType);
    const extension = EXTENSION_BY_MIME[normalized];
    if (!extension) throw new Error(`Cannot display ${mimeType || 'an unknown media type'}.`);
    if (bytes.length === 0) throw new Error('The server returned an empty file.');
    if (bytes.length > MAX_MEDIA_BYTES) {
      throw new Error(`The file is ${Math.round(bytes.length / 1024 / 1024)}MB, which is too large to display.`);
    }

    const directory = this.sessionDirectory(sessionId);
    await mkdir(directory, { recursive: true });
    const name = `${randomUUID()}.${extension}`;
    await writeFile(join(directory, name), bytes);

    // The canonical type for the extension, not the one that came in: the extension is all the
    // protocol handler has to go on when it serves this back, so the two must agree.
    return {
      name,
      url: mediaUrl(sessionId, name),
      mimeType: MIME_BY_EXTENSION[extension],
      byteLength: bytes.length,
    };
  }

  /**
   * Read one stored file back, for the protocol handler. Returns null for anything this store
   * did not name, so a crafted URL cannot address a path outside the media directory.
   */
  async read(sessionId: string, name: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
    if (!SESSION_ID_PATTERN.test(sessionId) || !NAME_PATTERN.test(name)) return null;

    const path = join(this.sessionDirectory(sessionId), name);
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      const bytes = await readFile(path);
      const extension = name.slice(name.lastIndexOf('.') + 1);
      return { bytes, mimeType: MIME_BY_EXTENSION[extension] ?? 'application/octet-stream' };
    } catch {
      return null;
    }
  }

  /** Drop everything a conversation generated. Called when the conversation is deleted. */
  async forgetSession(sessionId: string): Promise<void> {
    if (!SESSION_ID_PATTERN.test(sessionId)) return;
    await rm(this.sessionDirectory(sessionId), { recursive: true, force: true });
  }

  private sessionDirectory(sessionId: string): string {
    if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
    return join(this.baseDirectory, sessionId);
  }
}

/**
 * Split a media URL back into its parts. Exported for the protocol handler and its test;
 * returns null for anything that is not a well-formed URL of this scheme.
 */
export function parseMediaUrl(url: string): { sessionId: string; name: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.hostname !== MEDIA_HOST) return null;

  const segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments.length !== 2) return null;
  return { sessionId: segments[0], name: segments[1] };
}
