import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/artifactParser.ts',
    // Server-only image moderation (Rekognition + jimp). A dedicated entry, kept OUT
    // of the barrel (src/index.ts), so importing @bike4mind/utils never drags the AWS
    // SDK / jimp into a bundle that doesn't moderate images (e.g. the CLI). See #660.
    'src/imageModeration/index.ts',
    // Server-only image downscaling (jimp), kept off the barrel for the same reason. #660
    'src/imageResize.ts',
    'src/llm/backend.ts',
    'src/escapeRegex.ts',
    'src/retrievalExclusion.ts',
    'src/registrableDomain.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  clean: false,
});
