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
 * The whole body is returned rather than streamed: these files are a few megabytes at most
 * (MediaStore refuses larger), and a complete response with a Content-Length is enough for
 * Chromium to seek inside an audio element.
 */
export function registerMediaProtocol(store: MediaStore): void {
  protocol.handle(MEDIA_SCHEME, async request => {
    const parsed = parseMediaUrl(request.url);
    if (!parsed) return new Response('Not found', { status: 404 });

    const file = await store.read(parsed.sessionId, parsed.name);
    if (!file) return new Response('Not found', { status: 404 });

    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        'Content-Type': file.mimeType,
        'Content-Length': String(file.bytes.length),
        'Cache-Control': 'no-store',
      },
    });
  });
}
