/**
 * @vitest-environment node
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 *
 * Image jobs moderate a WebP render by decoding it with a wasm codec the bundle cannot carry, so the generation
 * job Lambda ships it at its task root (b4m-core/utils/src/imageModeration/webpDecode.ts). SST stat()s every
 * copyFiles source, so a stale path fails the deploy; a dropped entry fails every WebP image job instead.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');

const QUEUES = read('infra/queues.ts');
const start = QUEUES.indexOf('const generationJobQueueSubscription = generationJobQueue.subscribe(');
const SUBSCRIPTION = QUEUES.slice(start, QUEUES.indexOf('\n);', start));

describe('generation job WebP decoder asset', () => {
  const entry = SUBSCRIPTION.match(/\{\s*from:\s*'([^']+)',\s*to:\s*'([^']+)'\s*\}/);

  it('is copied into the generation job Lambda', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(entry, 'copyFiles entry for webp_dec.wasm').not.toBeNull();
    expect(entry?.[2]).toBe('webp_dec.wasm');
  });

  it('copies from a path that exists, under the name webpDecode reads', () => {
    expect(existsSync(path.join(REPO_ROOT, entry?.[1] ?? ''))).toBe(true);
    expect(read('b4m-core/utils/src/imageModeration/webpDecode.ts')).toContain(
      `export const WEBP_DECODER_WASM = '${entry?.[2]}';`
    );
  });
});
