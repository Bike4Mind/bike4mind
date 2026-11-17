import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { WEBP_DECODER_WASM_HEX, WEBP_DECODER_WASM_VERSION } from './webpDecoderWasm.generated';

const require = createRequire(import.meta.url);

// The embedded wasm must match the installed glue JS that drives it. Regenerate with
// `pnpm --filter @bike4mind/utils generate:webp-wasm` after changing the pinned @jsquash/webp version.
describe('embedded WebP decoder wasm', () => {
  it('matches the installed @jsquash/webp package', () => {
    const installed = readFileSync(require.resolve('@jsquash/webp/codec/dec/webp_dec.wasm'));

    expect(WEBP_DECODER_WASM_VERSION).toBe(require('@jsquash/webp/package.json').version);
    expect(Buffer.from(WEBP_DECODER_WASM_HEX, 'hex').equals(installed)).toBe(true);
  });
});
