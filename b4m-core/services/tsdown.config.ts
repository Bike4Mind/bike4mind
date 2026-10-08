import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    // Lean, browser-safe entry (pure cost math). Client code must import from
    // '@bike4mind/services/imageCost', not the barrel, which is server-only.
    'src/imageCost/index.ts',
    // Pure widening rule; the settings modal imports it from '@bike4mind/services/lakeGateWideningRule'.
    'src/dataLakeService/lakeGateWideningRule.ts',
    // Pure lake-RAG eval bank + grader, importable as '@bike4mind/services/evals/lakeRag'.
    'src/llm/evals/lakeRag/index.ts',
    'src/apiKeyService/index.ts',
    'src/creditService/index.ts',
    'src/generationJobs/index.ts',
    'src/videoJobs/index.ts',
    'src/agentProactiveMessagingService/index.ts',
    'src/cliCompletions.ts',
    'src/llm/index.ts',
    'src/llm/StatusManager.ts',
    'src/llm/questStartBody.ts',
    'src/llm/toolFinishObserver.ts',
    // Narrow subpath entries: each is leaf-clean of llm/tools/index.ts, so a
    // route that only needs one of them stops tracing the tool registry.
    'src/llm/ChatCompletionInvoke.ts',
    'src/llm/ImageGeneration.ts',
    'src/llm/ImageEdit.ts',
    'src/llm/toolAvailability.ts',
    'src/llm/imageModerationGate.ts',
    'src/llm/SmallLLMService.ts',
    'src/llm/reranker/index.ts',
    'src/llm/intentClassifier.ts',
    'src/llm/refineText.ts',
    'src/llm/artifactGating.ts',
    'src/llm/agents/ServerAgentStore.ts',
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
