import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { protocol } from 'electron';
import { SKIN_FILE_TYPES, SKIN_SCHEME } from '@shared/mods';
import { matchesSignature, type SkinAsset } from './skinFolder';

/** Anything with assets to serve: a skin or a sound pack. They share the scheme, and a folder holds one mod, so ids never collide. */
export interface ServedMod {
  assets: ReadonlyMap<string, SkinAsset>;
}

/**
 * Declare the skin scheme before the app is ready. `standard` so a URL parses into host (the skin id)
 * and path; `secure` so it is not mixed content; `stream` so an <audio> element can play from it.
 * Not `bypassCSP`: the renderer's policy names this scheme in img-src and media-src only.
 */
export function registerSkinScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SKIN_SCHEME, privileges: { standard: true, secure: true, stream: true } },
  ]);
}

/** Serve skin assets. Must run after the app is ready. `skins` is read per request, so a rescan applies at once. */
export function registerSkinProtocol(skins: () => ReadonlyMap<string, ServedMod>): void {
  protocol.handle(SKIN_SCHEME, request => serveSkinAsset(skins(), request.url));
}

const NOT_FOUND = (): Response => new Response('Not found', { status: 404 });

/**
 * Answers only for a file a validated skin's tokens reference, looked up by exact path: there is no
 * path resolution here to get wrong. The file is re-read whole within its type's cap and its signature
 * re-checked, since it may have changed on disk since the scan.
 */
export async function serveSkinAsset(skins: ReadonlyMap<string, ServedMod>, url: string): Promise<Response> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NOT_FOUND();
  }
  if (parsed.protocol !== `${SKIN_SCHEME}:` || parsed.search || parsed.hash) return NOT_FOUND();
  const asset = skins.get(parsed.hostname)?.assets.get(parsed.pathname.slice(1));
  if (!asset || asset.type === 'json') return NOT_FOUND();

  const { maxBytes, mimeType } = SKIN_FILE_TYPES[asset.type];
  let body: Buffer;
  try {
    // O_NOFOLLOW covers only the last component; a parent directory swapped for a link since the scan shows up here.
    if ((await realpath(asset.absolutePath)) !== asset.absolutePath) return NOT_FOUND();
    // O_NOFOLLOW: a file swapped for a link since the scan is refused, not followed (no-op on Windows).
    const handle = await open(asset.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxBytes) return NOT_FOUND();
      body = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return NOT_FOUND();
  }
  if (!matchesSignature(asset.type, body)) return NOT_FOUND();

  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(body.length),
      'Content-Security-Policy': "default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}
