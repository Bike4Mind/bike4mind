import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/artifactParser.ts',
    // Own entry so the client can import the elision detector without pulling the whole
    // utils barrel into the browser bundle (same reason as artifactParser above).
    'src/artifactElision.ts',
    // Own entries so the client re-exports (and the sandbox route, which evaluates
    // createImportScanner's compiled source) reach these without the utils barrel.
    'src/toolOutputResultScan.ts',
    'src/importStatements.ts',
    // Server-only image moderation (Rekognition + jimp). A dedicated entry, kept OUT
    // of the barrel (src/index.ts), so importing @bike4mind/utils never drags the AWS
    // SDK / jimp into a bundle that doesn't moderate images (e.g. the CLI). See #660.
    'src/imageModeration/index.ts',
    // Server-only image downscaling (jimp), kept off the barrel for the same reason. #660
    'src/imageResize.ts',
    'src/llm/backend.ts',
    'src/escapeRegex.ts',
    'src/safeObjectKey.ts',
    'src/globMatches.ts',
    // Own entry so the CLI can import scaleTokenEstimate without pulling the whole utils
    // barrel (and its llm-adapters/fab-pipeline side effects) into its bundle.
    'src/calibratedTokenizer.ts',
    'src/contentDisposition.ts',
    // Own entry so client-side `server/` modules (covered by client vitest) can import the
    // id normalizer via the lightweight subpath instead of dragging the whole barrel in.
    'src/normalizeId.ts',
    'src/retrievalExclusion.ts',
    'src/registrableDomain.ts',
    // Own entry so callers that only need at-rest crypto (apps/client server routes, the
    // database repositories, migration scripts) import it without dragging the whole utils
    // barrel - which reaches artifactParser and other modules - into their graph or tests.
    'src/security/index.ts',
    // Kind-agnostic provider interface, registry and errors shared by videoProviders and musicProviders. Own entry
    // so a music job can import the shared error classes without pulling in the video adapters.
    'src/generationProviders/index.ts',
    // Provider interface, registry and TestVideoProvider for the video job engine. Own entry so the barrel
    // stays light; conformance.ts (imports vitest) is not reachable from it and so never ships.
    'src/videoProviders/index.ts',
    // Music provider interface, registry and adapters, isolated the same way as videoProviders.
    'src/musicProviders/index.ts',
    // Decision provider interface, registry, retry policy and adapters. Same isolation as videoProviders.
    'src/decisionProviders/index.ts',
    // Batch-first embedding provider interface, registry and adapters. Same isolation as videoProviders.
    'src/embeddingProviders/index.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  clean: false,
});
