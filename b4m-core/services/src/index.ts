export * as referService from './referService';
export * as userService from './userService';
export * as authSessionService from './authSessionService';
export * as userApiKeyService from './userApiKeyService';
export * as counterService from './countersService';
export * as importHistoryService from './importHistoryService';
export * as sessionService from './sessionService';
export * as organizationService from './organizationService';
export * as apiKeyService from './apiKeyService';
export * as promptService from './promptService';
export * as voiceService from './voiceService';
export * as fabFilesService from './fabFileService';
export * as sharingService from './sharingService';
export * as projectService from './projectService';
export * as friendshipService from './friendshipService';
export * as adminService from './adminService';
export * as cacheService from './cacheService';
export * as embeddingCacheService from './embeddingCacheService';
export * as researchAgentService from './researchAgentService';
export * as researchTaskService from './researchTaskService';
export * as researchDataService from './researchData';
export * as taskSchedulerService from './taskSchedulerService';
export * as modelDiscoveryService from './modelDiscoveryService';
export * as tagService from './tagService';
export * as artifactService from './artifactService';
export * as notebookExportService from './notebookExportService';
export * as notebookImportService from './notebookImportService';
export * as notebookCurationService from './notebookCurationService';
export * as dataLakeService from './dataLakeService';
export * as dataLakeResearchService from './dataLakeResearchService';
export * as scopedSettingsService from './settings';
export * as briefcaseService from './briefcaseService';
export * as imageTemplateService from './imageTemplateService';
export * as cheerioService from './lib/cheerio';
export * as turndownService from './lib/turndown';
export * as speechToTextService from './speech';
export * as mfaService from './mfaService';
export * as adminSettingsService from './adminSettingsService';
export * as creditService from './creditService';
export * from './billing';
export * as spendReconciliationService from './spendReconciliation';
export * from './soundCost';
export * from './musicCost';
export * from './llm/agentToolMediaCost';
export * as emailIngestionService from './emailIngestionService';
export * as emailAnalysisService from './emailAnalysisService';
export * as mementoService from './mementoService';
export * as agentMemoryService from './agentMemoryService';
export * as conversationContextService from './conversationContextService';
export * from './auth';
// The LLM surface is deliberately NOT re-exported here. Everything below './llm'
// reaches the tool registry (llm/tools/index.ts), which eagerly imports every tool
// implementation and its dependencies. Because @vercel/nft traces files rather than
// used bindings, a single `export *` from here puts that whole closure in the Next
// server bundle for every consumer that only wanted a plain *Service namespace
// (~397 apps/client files import this barrel; severing the LLM surface drops the
// pages/api routes that reach the tool closure from 773 to 40 of 787).
// Import these from their subpaths instead:
//   '@bike4mind/services/llm', '@bike4mind/services/cliCompletions',
//   '@bike4mind/services/agentProactiveMessagingService'
// services/src/index.closure.test.ts fails if any of them comes back.
//
// The tool CONTRACT types are the exception, and they are free: `export type` is
// erased by tsc, so @vercel/nft follows no edge and no tool code is traced. Tool
// implementors (including the premium overlays) get the contract from the barrel
// while every value stays behind ./llm. Sourced from the types leaf rather than
// llm/tools so this line can never become a value edge by a one-word edit.
export type { ToolDefinition, ToolContext } from './llm/tools/base/types';

// Three LLM VALUES stay on the barrel deliberately. All are leaves that reach
// neither the tool registry nor any heavy dependency (mathjs, isolated-vm,
// sharp), so re-exporting them costs a few files in the barrel closure and no
// tracer edge to the registry - measured, and index.closure.test.ts still
// asserts the registry is unreachable from here. Out-of-repo consumers import
// them from the root, and severing them buys nothing, so the compat surface is
// cheaper than the coordinated churn. Anything that DOES reach the registry
// (ChatCompletionProcess, b4mTools, generateTools, ...) stays behind './llm'.
export { firecrawlFetch } from './llm/tools/implementation/webfetch';
export { createSmallLLMService } from './llm/SmallLLMService';
export { buildCorrectionPairs, type EvalPair, type CorrectionPairReader } from './llm/correctionPairs';
export * as cliTools from './cliTools';
export * from './latticeService';
export * from './telemetry';
export { safeCompareTokens } from './utils/crypto';
export { SreAgentService, type SrePatternLookup } from './sreAgentService';
export { RATE_LIMITED_SENTINEL } from './sreAgentService/tools';
export * from './audienceVariants';
// Flat exports for the client components/hooks (which import the contract types
// directly, per the package's dominant convention) plus the `prReportService`
// namespace the server-side adapters in context.ts/send.ts/generate.ts consume.
export * from './prReportService';
export * as prReportService from './prReportService';
