import type { SandboxAsset } from './renderSandboxedBundle';

/**
 * Publish - gated-asset collector for the sandboxed viewer.
 *
 * For non-public bundles, the opaque-origin iframe cannot fetch assets through
 * the gated `/p/...` route (an uncredentialed request would 401/403). So the app
 * origin - which holds the viewer's credential and has already passed the
 * visibility gate - pre-fetches the bundle's assets here and the serializer
 * inlines them into the `srcdoc`.
 *
 * Inlining base64-encodes bytes (~33% inflation) into a single response, so this
 * is bounded by two caps to stay under the route's `responseLimit` (15mb):
 *   - per-asset cap: skip any single oversized file (reported, not fatal)
 *   - cumulative cap: stop inlining once the running raw total is reached
 * Caps are measured in RAW bytes: the 6 MB cumulative cap ≈ 8 MB once base64-encoded,
 * leaving ~7 MB of the 15 MB `responseLimit` for index.html + the wrapper page.
 *
 * Fetches run concurrently (bounded by CONCURRENCY) for latency, then the caps are
 * applied in a deterministic SECOND pass over the manifest order - so which assets
 * land in-budget never depends on network race ordering. Skipped assets are reported
 * (never silently dropped) so the caller can surface a degraded-render notice.
 * `index.html` is excluded - it is the document, not an inlined asset. I/O is injected
 * via `load` to keep this unit-testable.
 */

/** Skip any single asset larger than this raw-byte size. */
export const PER_ASSET_MAX_BYTES = 3 * 1024 * 1024;
/** Stop inlining once the cumulative raw-byte total reaches this size (≈ 8 MB base64). */
export const TOTAL_INLINE_MAX_BYTES = 6 * 1024 * 1024;
/** Max concurrent asset downloads - bounds S3 fan-out without serializing latency. */
const CONCURRENCY = 8;

export interface CollectInlineAssetsInput {
  /** Bundle manifest (path + mimeType). `index.html` is skipped automatically. */
  manifest: ReadonlyArray<{ path: string; mimeType: string }>;
  /** Loader for a single asset's bytes, keyed by its manifest path. */
  load: (path: string) => Promise<Buffer>;
  perAssetMaxBytes?: number;
  totalMaxBytes?: number;
}

export interface CollectInlineAssetsResult {
  /** Successfully fetched, in-budget assets keyed by manifest path. */
  assets: Map<string, SandboxAsset>;
  /** Paths skipped because they exceeded a size cap (per-asset or cumulative). */
  oversized: string[];
  /** Paths that failed to download. */
  failed: string[];
}

export async function collectInlineAssets(input: CollectInlineAssetsInput): Promise<CollectInlineAssetsResult> {
  const perAssetMax = input.perAssetMaxBytes ?? PER_ASSET_MAX_BYTES;
  const totalMax = input.totalMaxBytes ?? TOTAL_INLINE_MAX_BYTES;
  const paths = input.manifest.filter(e => e.path !== 'index.html').map(e => e.path);

  // Pass 1 - fetch concurrently (bounded). Preserve per-path success/failure; the
  // cap decisions happen in pass 2 so they don't depend on completion order.
  const fetched = new Map<string, Buffer>();
  const failed: string[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < paths.length) {
      const path = paths[cursor++];
      try {
        fetched.set(path, await input.load(path));
      } catch {
        failed.push(path);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, paths.length) }, worker));

  // Pass 2 - apply caps deterministically in manifest order.
  const assets = new Map<string, SandboxAsset>();
  const oversized: string[] = [];
  let runningTotal = 0;
  const mimeByPath = new Map(input.manifest.map(e => [e.path, e.mimeType]));
  for (const path of paths) {
    const data = fetched.get(path);
    if (!data) continue; // download failed — already recorded
    if (data.length > perAssetMax || runningTotal + data.length > totalMax) {
      oversized.push(path);
      continue;
    }
    runningTotal += data.length;
    assets.set(path, { data, mimeType: mimeByPath.get(path)! });
  }

  // Stable ordering for callers/tests regardless of fetch-completion order.
  failed.sort((a, b) => paths.indexOf(a) - paths.indexOf(b));
  return { assets, oversized, failed };
}
