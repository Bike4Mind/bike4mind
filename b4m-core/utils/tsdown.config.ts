import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/artifactParser.ts',
    // Own entry so the client can import the elision detector without pulling the whole
    // utils barrel into the browser bundle (same reason as artifactParser above).
    'src/artifactElision.ts',
    // Server-only image moderation (Rekognition + jimp). A dedicated entry, kept OUT
    // of the barrel (src/index.ts), so importing @bike4mind/utils never drags the AWS
    // SDK / jimp into a bundle that doesn't moderate images (e.g. the CLI). See #660.
    'src/imageModeration/index.ts',
    // Server-only image downscaling (jimp), kept off the barrel for the same reason. #660
    'src/imageResize.ts',
    'src/llm/backend.ts',
    'src/escapeRegex.ts',
    // Own entry so client-side `server/` modules (covered by client vitest) can import the
    // id normalizer via the lightweight subpath instead of dragging the whole barrel in.
    'src/normalizeId.ts',
    'src/retrievalExclusion.ts',
    'src/registrableDomain.ts',
    // Own entry so callers that only need at-rest crypto (apps/client server routes, the
    // database repositories, migration scripts) import it without dragging the whole utils
    // barrel - which reaches artifactParser and other modules - into their graph or tests.
    'src/security/index.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  clean: false,
});
