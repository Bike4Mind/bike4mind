# Decomposition map: ChatCompletionProcess and the tools layer

**This is a PROPOSED refactoring target, not a description of current code.** Every
row below states where the corresponding responsibility lives *today* so a future
refactorer can jump straight to the code, decide whether the proposed seam still
makes sense, and extract it. No source in this directory has been changed to match
these maps - this document is planning material only.

Two things worth correcting up front, since an earlier writeup of this decomposition
got them wrong:

- The pipeline entry point is the `process()` **method** on the `ChatCompletionProcess`
  **class**, not a free function `processChatCompletion`.
- It lives at `b4m-core/services/src/llm/ChatCompletionProcess.ts`
  (class at `ChatCompletionProcess.ts:348`, method at `ChatCompletionProcess.ts:595`;
  the file is ~4,300 lines), not under `apps/client`.

## 1. `ChatCompletionProcess.process()` decomposition

Of the 18 conceptual steps below, about a dozen already exist as first-class
`ChatCompletionFeature` classes (mostly in `ChatCompletionFeatures.ts`, a few split
into their own file under `features/`). The rest are inline blocks or helper calls
within `process()` itself. Real runtime phase instrumentation does not use these 18
names - it uses `PipelineTimer` phases (`init`, `essential_data`, `features_build`,
`features_before`, `history`, `data_sources`, `tool_setup`, `message_building`,
`llm_completion`, `post_process`, `save`, `on_complete` - see the `timer.phase(...)`
calls threaded through `process()`). The 18-step split below is a proposed
*conceptual* grouping for extraction, not the pipeline's current internal vocabulary.

| Step | Responsibility | Current home | Standalone today? |
|---|---|---|---|
| agentDetection | Detect `@agent` mentions / route to a sub-agent | `AgentDetectionFeature` class - `features/AgentDetectionFeature.ts:15` | Yes (Feature class) |
| toolManagement | Assemble the tool list for the LLM call (built-in, MCP, premium) | `ToolBuilder` class (`tools/ToolBuilder.ts:288`) + `ToolManager` object (`tools/toolManager.ts:21`), invoked from `process()` | Partially - real class/module, but not a discrete pipeline "step" |
| contextManagement | Trim/summarize history to fit the context window | Inline history-length calc + `buildAndSortMessages` (from `@bike4mind/utils`) in `process()`, plus `ContextSummarizationFeature` class - `ChatCompletionFeatures.ts:1404` | Partially (summarization is a Feature; trimming/sorting is inline) |
| creditValidation | Check the caller can afford the request before starting work | Inline: `reservedCredits`/`reservedCreditsOwnerId` fields (`ChatCompletionProcess.ts:391-393`) + `adminSettingsEnforceCredits` gate (`ChatCompletionProcess.ts:1080`) | No (inline) |
| creditDeduction | Charge credits once the call completes | `deductCreditsWithOrgSupport` (`creditService/deductCreditsWithOrgSupport.ts:122`) and `subtractCredits` (`creditService/subtractCredits.ts:65`), called from `process()` | Yes (own module), but invoked inline, not as a Feature |
| memento | Persist/recall long-term memory for the session | `MementoFeature` class - `ChatCompletionFeatures.ts:372` | Yes (Feature class) |
| projectContext | Pull in project-scoped context/config | `ProjectFeature` class - `ChatCompletionFeatures.ts:884` | Yes (Feature class) |
| questMaster | QuestMaster-specific status/behavior | `QuestMasterFeature` class - `ChatCompletionFeatures.ts:563` | Yes (Feature class) |
| researchMode | Deep-research mode orchestration | `ResearchModeService` class - `ResearchModeService.ts:17` | Yes (own class, not a `ChatCompletionFeature`) |
| statusUpdates | Push progress/status to the client mid-request | `StatusManager` class - `StatusManager.ts:21`, invoked via `this.sendStatusUpdate(...)` throughout `process()` | Yes (own class) |
| performanceTracking | Time each pipeline phase, emit telemetry | `PipelineTimer` (from `@bike4mind/llm-adapters`, used at `ChatCompletionProcess.ts:616`) + `TelemetryBuilder` (from `../telemetry`, used at `ChatCompletionProcess.ts:1129`) | Yes (both are real, reusable classes) |
| modelManagement | Resolve model id, look up backend, handle deprecations | Inline: `resolveDeprecatedModelId` (`ChatCompletionProcess.ts:1025`), `getAvailableModels` / `getLlmByModel` (from `@bike4mind/llm-adapters`) | No (inline calls to shared helpers) |
| classifyQueryComplexity | Classify query complexity to pick an optimized feature set | `classifyQueryComplexity` - `b4m-core/common/src/queryComplexityClassifier.ts:32`, consumed by inline `getOptimizedFeatures` closure (`ChatCompletionProcess.ts:704`) | Partially (classifier is standalone; feature-selection logic is inline) |
| contentModeration | Screen prompts for policy violations | Inline: `OpenaiModerationsService` (from `@bike4mind/utils`, instantiated at `ChatCompletionProcess.ts:1187`) + `applyModerationHit`/`MODERATION_POLICY` (`../userService/moderationPolicy`) | No (inline) |
| fileProcessing | Fetch/convert attached files and URLs referenced in the prompt | Inline calls to `fetchAndConvertFabFiles`, `processFabFilesServer`, `processUrlsFromPrompt` (all from `@bike4mind/utils`) | No (inline calls to shared helpers) |
| artifactProcessing | Detect and emit generated artifacts (files, code, charts) | Inline: `ARTIFACT_EMISSION_PROMPT` / `mapMimeTypeToArtifactType` (from `@bike4mind/common`, used around `ChatCompletionProcess.ts:1628`) | No (inline) |
| rapidReply | Short-circuit with a cached/blank rapid-reply result | Inline: `rapidReplyPromise` (`ChatCompletionProcess.ts:660`) against `this.db.rapidReply` | No (inline) |
| cancellationHandling | Let the caller abort an in-flight request | Inline: `abortControllers` map field (`ChatCompletionProcess.ts:379`) + `cancelWatcherInterval` (`ChatCompletionProcess.ts:800`) + module-level `isAbortError` helper (`ChatCompletionProcess.ts:300`) | No (inline) |

Two feature-like classes exist outside the 18-step list and outside
`ChatCompletionFeatures.ts` but are worth noting for anyone doing this extraction:
`SlackFeature` (`ChatCompletionFeatures.ts:455`), `AutoNameSessionFeature`
(`ChatCompletionFeatures.ts:486`), `SummarizeNotebookFeature`
(`ChatCompletionFeatures.ts:1019`), `OrganizationPromptFeature`
(`ChatCompletionFeatures.ts:1060`), `SessionPromptFeature`
(`ChatCompletionFeatures.ts:1111`), `KnowledgeRetrievalFeature`
(`ChatCompletionFeatures.ts:1171`), and `SkillsFeature`
(`features/SkillsFeature.ts:37`).

### Infrastructure contracts

These are the seams `process()` currently depends on through constructor options or
direct imports. Two (`LLMBackend`, `McpClient`) are already behind a narrow
interface passed into the class; the other two proposed contracts
(`ConnectionRepository`, `ModelService`) don't exist yet - `process()` reaches
directly for a concrete sender/helper instead.

| Contract | What it abstracts | Closest thing today |
|---|---|---|
| ConnectionRepository (proposed seam) | Sending messages/status back to the connected client | No interface - `process()` constructs `ClientMessageSender` directly (from `@bike4mind/utils`, e.g. `ChatCompletionProcess.ts:483`) and calls `.sendToClient(...)` with `this.wsHttpsUrl` |
| LLMBackend (exists today) | Talking to a model provider | `ICompletionBackend` (from `@bike4mind/llm-adapters`), obtained via `getLlmByModel` |
| McpClient (exists today) | Connecting to an MCP server | `this.getMcpClient` field (`ChatCompletionProcess.ts:376`), typed as `IChatCompletionServiceOptions['getMcpClient']` and injected via constructor options |
| MementoService (exists today) | Creating/recalling memento records | `this.invokeCreateMemento` field (`ChatCompletionProcess.ts:350`), injected via constructor options and used by `MementoFeature` |
| ModelService (proposed seam) | Resolving a model id to an available backend | No interface - inline calls to `getAvailableModels` / `getLlmByModel` (`@bike4mind/llm-adapters`) |
| StatusManager (exists today) | Throttled status/progress updates to the client | `StatusManager` class - `StatusManager.ts:21` |

## 2. Tools layer decomposition

None of the 16 provider contracts below exist in current code - there is no `Tool`
base interface and no `ToolRegistry`/`createToolRegistry`. They are a proposed
target seam set. Today, each capability is a standalone `*Tool` object exported from
its own directory under `tools/implementation/`, imported individually into
`tools/index.ts`, and assembled per-request by `ToolBuilder` (`tools/ToolBuilder.ts:288`)
and the `ToolManager` helpers (`tools/toolManager.ts:21`), with `ToolCacheManager`
(`tools/ToolCacheManager.ts:31`) and `ToolValidator` (`tools/ToolValidator.ts:36`) as
supporting infrastructure. Tool-facing types (`ToolContext`, `ToolDefinition`) live in
`tools/base/types.ts`.

There are currently 40 tool directories under `tools/implementation/` (verified via
`ls`, not the ~18 figure from the earlier writeup): `askUserQuestion`, `bashExecute`,
`blogDraft`, `blogEdit`, `blogPublish`, `chessEngine`, `createFile`, `currentDateTime`,
`deepResearch`, `deleteFile`, `diceroll`, `editFile`, `editLocalFile`,
`excelGeneration`, `fileRead`, `fmp`, `globFiles`, `grepSearch`, `imageEdit`,
`imageGeneration`, `issTracker`, `jupyterNotebook`, `knowledgeBaseRetrieve`,
`knowledgeBaseSearch`, `lattice`, `math`, `mermaidChart`, `moonPhase`, `navigateView`,
`planetVisibility`, `promptEnhancement`, `recentChanges`, `recharts`, `skill`,
`sunriseSunset`, `weather`, `webfetch`, `websearch`, `wikipediaOnThisDay`,
`wolfram_alpha`. (`tools/` also has two agent-delegation tools that sit outside
`implementation/`: `coordinateTask.ts` and `delegateToAgent.ts`.)

| Proposed provider contract | Current concrete tool(s) that would implement it |
|---|---|
| SearchProvider | `webSearchTool` (`tools/implementation/websearch`) + `deepResearchTool` (`tools/implementation/deepResearch`) |
| WebFetchProvider | `webFetchTool` (`tools/implementation/webfetch`) |
| WeatherProvider | `weatherTool` (`tools/implementation/weather`) |
| ISSProvider | `issTrackerTool` (`tools/implementation/issTracker`) |
| AstronomyProvider | `moonPhaseTool`, `sunriseSunsetTool`, `planetVisibilityTool` (`tools/implementation/moonPhase`, `sunriseSunset`, `planetVisibility`) |
| KnowledgeBaseProvider | `knowledgeBaseSearchTool`, `knowledgeBaseRetrieveTool` (`tools/implementation/knowledgeBaseSearch`, `knowledgeBaseRetrieve`) |
| FinanceProvider | `fmpTool` (`tools/implementation/fmp`) |
| WikipediaProvider | `wikipediaOnThisDayTool` (`tools/implementation/wikipediaOnThisDay`) |
| MathProvider | `mathTool` (`tools/implementation/math`), `wolframAlphaTool` (`tools/implementation/wolfram_alpha`) |
| ChartingProvider | `rechartsTool`, `mermaidChartTool` (`tools/implementation/recharts`, `mermaidChart`) |
| FileSystemProvider | `editFileTool` (`tools/implementation/editFile`, wired into the web app via `tools/index.ts`) plus `fileReadTool`, `createFileTool`, `editLocalFileTool`, `deleteFileTool`, `globFilesTool`, `grepSearchTool` (`tools/implementation/fileRead`, `createFile`, `editLocalFile`, `deleteFile`, `globFiles`, `grepSearch` - CLI-only, wired via `tools/cliTools.ts`, not `tools/index.ts`) |
| CodeExecutionProvider | `jupyterNotebookTool` (`tools/implementation/jupyterNotebook`, web-wired) and `bashExecuteTool` (`tools/implementation/bashExecute` - CLI-only, wired via `tools/cliTools.ts`) |
| ImageProvider | `imageGenerationTool`, `imageEditTool` (`tools/implementation/imageGeneration`, `imageEdit`) |
| DocumentProvider | `excelGenerationTool` (`tools/implementation/excelGeneration`) |
| BlogProvider | `blogDraftTool`, `blogEditTool`, `blogPublishTool` (`tools/implementation/blogDraft`, `blogEdit`, `blogPublish`) |
| SkillProvider | `skillTool` (`tools/implementation/skill`) |

Not mapped to a provider contract above (utility/meta tools with no obvious provider
seam): `diceRollTool`, `currentDateTimeTool`, `promptEnhancementTool`,
`navigateViewTool`, `chessEngineTool`, `recentChangesTool`, the `lattice` family, and
`askUserQuestion` - plus the two agent-delegation tools (`coordinateTask.ts`,
`delegateToAgent.ts`) and any tools supplied at runtime by premium overlay packages
(`PremiumOverlayToolName`, `tools/index.ts:18`).

### Target wiring vs current wiring

- **Proposed:** a `Tool` base interface every provider implements, registered into a
  `ToolRegistry` built by `createToolRegistry()`, so adding a tool means registering
  an implementation rather than editing a central import list.
- **Current:** `tools/index.ts` hand-imports one `*Tool` object per capability from
  `tools/implementation/<name>/`, and `ToolBuilder` assembles the active set per
  request (built-in + MCP + premium overlay), with `ToolManager`,
  `ToolCacheManager`, and `ToolValidator` handling filtering, caching, and
  execution-result validation respectively.

## Closing note

No code has been moved, renamed, or ported as part of this document. Treat the
tables above as the target shape - not the current one - the next time
`ChatCompletionProcess.ts` or the tools layer under `tools/` is refactored.
