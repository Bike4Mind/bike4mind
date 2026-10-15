import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import { MEDIA_SCHEME, parseMediaUrl, type MediaStore } from './MediaStore';

/**
 * Declare the media scheme before the app is ready.
 *
 * `standard` gives it an origin so the URL parses into host + path; `secure` keeps a page
 * loading it from being treated as mixed content; `supportFetchAPI`/`stream` are what let an
 * `<audio>` element use it. Deliberately NOT `bypassCSP` - the renderer's policy names this
 * scheme explicitly, so widening it stays a visible edit to index.html.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/**
 * Serve stored media to the renderer. Must run after the app is ready.
 *
 * Streamed from disk and range-aware: a video element seeks with Range requests and will not
 * scrub without a 206, and reading a whole clip into memory per request would make a thread of
 * videos expensive to open.
 */
export function registerMediaProtocol(store: MediaStore): void {
  protocol.handle(MEDIA_SCHEME, request => serveMedia(store, request));
}

export async function serveMedia(store: MediaStore, request: Request): Promise<Response> {
  const parsed = parseMediaUrl(request.url);
  if (!parsed) return new Response('Not found', { status: 404 });

  const file = await store.locate(parsed.sessionId, parsed.name);
  if (!file) return new Response('Not found', { status: 404 });

  const headers: Record<string, string> = {
    'Content-Type': file.mimeType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const range = parseRange(request.headers.get('range'), file.size);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${file.size}` } });
  }

  const { start, end } = range ?? { start: 0, end: file.size - 1 };
  const body = file.size === 0 ? null : bodyOf(createReadStream(file.path, { start, end }));
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      ...headers,
      'Content-Length': String(file.size === 0 ? 0 : end - start + 1),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${file.size}` } : {}),
    },
  });
}

// Node's web stream type and the DOM one Response is typed against are the same object at runtime.
const bodyOf = (stream: ReturnType<typeof createReadStream>): ReadableStream =>
  Readable.toWeb(stream) as unknown as ReadableStream;

/**
 * One `bytes=` range, or null to send the whole file. Multi-range requests are answered whole,
 * which RFC 9110 allows; no media element sends one.
 */
export function parseRange(
  header: string | null,
  size: number
): { start: number; end: number } | 'unsatisfiable' | null {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const [, from, to] = match;
  if (from === '' && to === '') return null;

  let start: number;
  let end: number;
  if (from === '') {
    const suffix = Number(to);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
