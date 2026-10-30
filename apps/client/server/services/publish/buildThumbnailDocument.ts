import { createHash } from 'node:crypto';
import { BLESSED_SCRIPT_PATHS } from '@bike4mind/common';
import { collectInlineAssets } from './collectInlineAssets';
import { isBundlePagePath, renderSandboxedBundle, resolveBundlePath } from './renderSandboxedBundle';
import { isStreamedFile } from './signedFiles';
import { PUBLISH_HOST } from './validateBundle';

/**
 * Publish - the self-contained document an owner-only thumbnail is rendered from
 * (apps/workers/src/queueHandlers/publishThumbnail.ts).
 *
 * Built straight from storage with the worker's own read access, so a gated or private artifact
 * is never exposed through any URL to be screenshotted: no serve route, no link into the artifact's
 * own files, no new token. The renderer function receives only this built document. Every bundle
 * asset is inlined (renderSandboxedBundle's `inline` mode, the gated-viewer model), which leaves
 * the blessed library scripts as the only thing the render could fetch.
 *
 * A baked sign-up gate is rendered dismissed, as the owner sees the page: the thumbnail depicts
 * the artifact, not the anonymous-viewer prompt. Media that is always streamed (video, audio, PDF)
 * is skipped rather than inlined - a still frame does not need it, and it is what would blow the
 * render's memory.
 */

export interface ThumbnailDocument {
  /** Bundle HTML with every asset inlined - host it in a sandboxed frame, never as a top-level page. */
  srcdoc: string;
  /** Exact URLs the render may load: the blessed library scripts on the app origin(s). */
  allowedScriptUrls: string[];
  /**
   * Assets the render goes without, as bundle paths. Always-streamed media is left out on purpose
   * and is not listed here.
   */
  droppedAssets: DroppedAssets;
}

export interface DroppedAssets {
  /** Referenced by the page but not in the bundle at all. */
  missing: string[];
  /** In the bundle but over an inline size cap (collectInlineAssets.ts). */
  oversized: string[];
  /** In the bundle but failed to load from storage. */
  failed: string[];
}

export interface BuildThumbnailDocumentInput {
  /** sha256Index the thumbnail is for. */
  versionId: string;
  manifest: ReadonlyArray<{ path: string; mimeType: string }>;
  /** Reads one bundle file by manifest path (index.html included). */
  load: (path: string) => Promise<Buffer>;
  /** App origin the blessed `/static/lib` scripts resolve against, e.g. `https://app.example.com`. */
  appOrigin: string;
}

/**
 * Returns null when the stored index.html no longer hashes to `versionId`: a newer publish has
 * overwritten it, and the job queued for that publish renders it instead.
 */
export async function buildThumbnailDocument(input: BuildThumbnailDocumentInput): Promise<ThumbnailDocument | null> {
  const indexBytes = await input.load('index.html');
  if (createHash('sha256').update(indexBytes).digest('hex') !== input.versionId) return null;

  const origin = toHttpOrigin(input.appOrigin);
  const collected = await collectInlineAssets({
    manifest: input.manifest.filter(f => !isBundlePagePath(f.path) && !isStreamedFile(f.path)),
    load: input.load,
  });
  const { srcdoc, droppedAssets } = renderSandboxedBundle({
    indexHtml: dismissSignupGate(indexBytes.toString('utf-8')),
    urlBase: '',
    origin,
    visibility: 'private',
    assetMode: 'inline',
    assets: collected.assets,
  });

  // A dropped ref to a bundle file is already covered: oversized, failed, or streamed media skipped above.
  const bundlePaths = new Set(input.manifest.map(f => f.path));
  const missing = droppedAssets
    .map(ref => resolveBundlePath('index.html', ref) ?? ref)
    .filter(path => !bundlePaths.has(path));

  const scriptOrigins = [...new Set([origin, PUBLISH_HOST ? `https://${PUBLISH_HOST}` : ''].filter(Boolean))];
  return {
    srcdoc,
    allowedScriptUrls: scriptOrigins.flatMap(o => BLESSED_SCRIPT_PATHS.map(path => `${o}${path}`)),
    droppedAssets: { missing: [...new Set(missing)], oversized: collected.oversized, failed: collected.failed },
  };
}

// Opening of the gate's dismiss checkbox; must stay in sync with SIGNUP_GATE_MARKER in
// apps/client/app/utils/shareFooter.ts. Not stripSignupGateHtml from there: that module pulls
// browser-only code into the worker's typecheck. Pre-checking the box applies the page's own baked
// CSS for a viewer's "No thanks" click, so it hides whichever gate version the page carries.
const SIGNUP_GATE_DISMISS_INPUT = '<input type="checkbox" id="b4m-gate-dismiss"';

function dismissSignupGate(html: string): string {
  return html.split(SIGNUP_GATE_DISMISS_INPUT).join(`${SIGNUP_GATE_DISMISS_INPUT} checked`);
}

function toHttpOrigin(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : '';
  } catch {
    return '';
  }
}
