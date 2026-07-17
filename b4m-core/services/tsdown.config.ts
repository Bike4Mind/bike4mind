import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    // Lean, browser-safe entry (pure cost math). Client code must import from
    // '@bike4mind/services/imageCost', not the barrel, which is server-only.
    'src/imageCost/index.ts',
    'src/apiKeyService/index.ts',
    'src/creditService/index.ts',
    'src/llm/StatusManager.ts',
    'src/llm/tools/cliTools.ts',
    'src/llm/tools/index.ts',
    'src/llm/tools/implementation/webfetch/index.ts',
    'src/llm/tools/implementation/webfetch/scrapeWithRetry.ts',
    'src/llm/tools/implementation/websearch/index.ts',
    'src/mfaService/utils.ts',
    'src/organizationService/create.ts',
    'src/organizationService/revokeAccess.ts',
    'src/organizationService/update.ts',
    'src/sreAgentService/index.ts',
    'src/sreAgentService/tools.ts',
    'src/utils/crypto.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  clean: false,
});
