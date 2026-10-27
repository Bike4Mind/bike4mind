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
 * is bounded by two caps to stay under Lambda's 6 MB response limit:
 *   - per-asset cap: skip any single oversized file (reported, not fatal)
 *   - cumulative cap: stop inlining once the running ENCODED total (the `data:` URI
 *     length that actually lands in the response) reaches the budget, less
 *     `reservedBytes` for index.html
 * The ~1.5 MB between the budget and 6 MB absorbs the wrapper page and response
 * headers; callers pass the ESCAPED index.html size as `reservedBytes`.
 *
 * Fetches run concurrently (bounded by CONCURRENCY) for latency, then the caps are
 * applied in a deterministic SECOND pass over the manifest order (no-fallback assets
 * first when `hasFallback` is given) - so which assets land in-budget never depends on
 * network race ordering. Skipped assets are reported (never silently dropped) so the
 * caller can surface a degraded-render notice.
 * `index.html` is excluded - it is the document, not an inlined asset. I/O is injected
 * via `load` to keep this unit-testable.
 */

/** Skip any single asset larger than this raw-byte size. */
export const PER_ASSET_MAX_BYTES = 3 * 1024 * 1024;
/** Stop inlining once the cumulative base64-encoded total reaches this size. */
export const TOTAL_INLINE_MAX_BYTES = 4.5 * 1024 * 1024;
/** Max concurrent asset downloads - bounds S3 fan-out without serializing latency. */
const CONCURRENCY = 8;

export interface CollectInlineAssetsInput {
  /** Bundle manifest (path + mimeType). `index.html` is skipped automatically. */
  manifest: ReadonlyArray<{ path: string; mimeType: string }>;
  /** Loader for a single asset's bytes, keyed by its manifest path. */
  load: (path: string) => Promise<Buffer>;
  perAssetMaxBytes?: number;
  totalMaxBytes?: number;
  /** Bytes of the response already spoken for (e.g. index.html); subtracted from the total budget. */
  reservedBytes?: number;
  /** Paths the caller can still serve another way when they miss the budget; budgeted after the rest. */
  hasFallback?: (path: string) => boolean;
}

export interface CollectInlineAssetsResult {
  /** Successfully fetched, in-budget assets keyed by manifest path. */
  assets: Map<string, SandboxAsset>;
  /** Paths skipped because they exceeded a size cap (per-asset or cumulative). */
  oversized: string[];
  /** Paths that failed to download. */
  failed: string[];
}

/** Length of the `data:<mime>;base64,<...>` URI that inlining this asset produces. */
const encodedSize = (rawBytes: number, mimeType: string) =>
  'data:'.length + mimeType.length + ';base64,'.length + 4 * Math.ceil(rawBytes / 3);

export async function collectInlineAssets(input: CollectInlineAssetsInput): Promise<CollectInlineAssetsResult> {
  const perAssetMax = input.perAssetMaxBytes ?? PER_ASSET_MAX_BYTES;
  const totalMax = (input.totalMaxBytes ?? TOTAL_INLINE_MAX_BYTES) - (input.reservedBytes ?? 0);
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

  // Pass 2 - apply caps deterministically in manifest order, assets with no fallback first so
  // a stylesheet listed after the images is not the one left without a byte of budget.
  const assets = new Map<string, SandboxAsset>();
  const oversized: string[] = [];
  let runningTotal = 0;
  const mimeByPath = new Map(input.manifest.map(e => [e.path, e.mimeType]));
  const hasFallback = input.hasFallback ?? (() => false);
  const budgetOrder = [...paths.filter(p => !hasFallback(p)), ...paths.filter(hasFallback)];
  for (const path of budgetOrder) {
    const data = fetched.get(path);
    if (!data) continue; // download failed — already recorded
    const mimeType = mimeByPath.get(path)!;
    const encoded = encodedSize(data.length, mimeType);
    if (data.length > perAssetMax || runningTotal + encoded > totalMax) {
      oversized.push(path);
      continue;
    }
    runningTotal += encoded;
    assets.set(path, { data, mimeType });
  }

  // Stable ordering for callers/tests regardless of fetch-completion or budget order.
  oversized.sort((a, b) => paths.indexOf(a) - paths.indexOf(b));
  failed.sort((a, b) => paths.indexOf(a) - paths.indexOf(b));
  return { assets, oversized, failed };
}
