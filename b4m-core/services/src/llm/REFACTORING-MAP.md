# Decomposition map: ChatCompletionProcess and the tools layer

**This is a PROPOSED refactoring target, not a description of current code.** Every
row below states where the corresponding responsibility lives *today* so a future
refactorer can jump straight to the code, decide whether the proposed seam still
makes sense, and extract it. No source in this directory has been changed to match
these maps - this document is planning material only.

> Anchors below are file + symbol names on purpose - deliberately without line
> numbers. `ChatCompletionProcess.ts` in particular changes on nearly every merge,
> so any line number here would rot almost immediately; the file + symbol names do
> not. Grep the symbol to find it. All anchors were verified against `main` at
> commit `49ad15dca062`; if a symbol has since been renamed or moved, grep for it
> and diff against that commit.

Two things worth correcting up front, since an earlier writeup of this decomposition
got them wrong:

- The pipeline entry point is the `process()` **method** on the `ChatCompletionProcess`
  **class**, not a free function `processChatCompletion`.
- It lives at `b4m-core/services/src/llm/ChatCompletionProcess.ts` (a large file, a
  few thousand lines), not under `apps/client`.

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
| agentDetection | Detect `@agent` mentions / route to a sub-agent | `AgentDetectionFeature` class - `features/AgentDetectionFeature.ts` | Yes (Feature class) |
| toolManagement | Assemble the tool list for the LLM call (built-in, MCP, premium) | `ToolBuilder` class (`tools/ToolBuilder.ts`) + `ToolManager` object (`tools/toolManager.ts`), invoked from `process()` | Partially - real class/module, but not a discrete pipeline "step" |
| contextManagement | Trim/summarize history to fit the context window | Inline history-length calc + `buildAndSortMessages` (from `@bike4mind/utils`) in `process()`, plus `ContextSummarizationFeature` class - `ChatCompletionFeatures.ts` | Partially (summarization is a Feature; trimming/sorting is inline) |
| creditValidation | Check the caller can afford the request before starting work | Inline: `reservedCredits`/`reservedCreditsOwnerId` fields + `adminSettingsEnforceCredits` gate in `ChatCompletionProcess.ts` | No (inline) |
| creditDeduction | Charge credits once the call completes | `deductCreditsWithOrgSupport` (`creditService/deductCreditsWithOrgSupport.ts`) and `subtractCredits` (`creditService/subtractCredits.ts`), called from `process()` | Yes (own module), but invoked inline, not as a Feature |
| memento | Persist/recall long-term memory for the session | `MementoFeature` class - `ChatCompletionFeatures.ts` | Yes (Feature class) |
| projectContext | Pull in project-scoped context/config | `ProjectFeature` class - `ChatCompletionFeatures.ts` | Yes (Feature class) |
| questMaster | QuestMaster-specific status/behavior | `QuestMasterFeature` class - `ChatCompletionFeatures.ts` | Yes (Feature class) |
| researchMode | Deep-research mode orchestration | `ResearchModeService` class - `ResearchModeService.ts` | Yes (own class, not a `ChatCompletionFeature`) |
| statusUpdates | Push progress/status to the client mid-request | `StatusManager` class - `StatusManager.ts`, invoked via `this.sendStatusUpdate(...)` throughout `process()` | Yes (own class) |
| performanceTracking | Time each pipeline phase, emit telemetry | `PipelineTimer` (from `@bike4mind/llm-adapters`) + `TelemetryBuilder` (from `../telemetry`), used in `process()` | Yes (both are real, reusable classes) |
| modelManagement | Resolve model id, look up backend, handle deprecations | Inline: `resolveDeprecatedModelId`, `getAvailableModels` / `getLlmByModel` (from `@bike4mind/llm-adapters`) in `ChatCompletionProcess.ts` | No (inline calls to shared helpers) |
| classifyQueryComplexity | Classify query complexity to pick an optimized feature set | `classifyQueryComplexity` - `b4m-core/common/src/queryComplexityClassifier.ts`, consumed by inline `getOptimizedFeatures` closure in `process()` | Partially (classifier is standalone; feature-selection logic is inline) |
| contentModeration | Screen prompts for policy violations | Inline: `OpenaiModerationsService` (from `@bike4mind/utils`) + `applyModerationHit`/`MODERATION_POLICY` (`../userService/moderationPolicy`) in `process()` | No (inline) |
| fileProcessing | Fetch/convert attached files and URLs referenced in the prompt | Inline calls to `fetchAndConvertFabFiles`, `processFabFilesServer`, `processUrlsFromPrompt` (all from `@bike4mind/utils`) | No (inline calls to shared helpers) |
| artifactProcessing | Detect and emit generated artifacts (files, code, charts) | Inline: `ARTIFACT_EMISSION_PROMPT` / `mapMimeTypeToArtifactType` (from `@bike4mind/common`) in `process()` | No (inline) |
| rapidReply | Short-circuit with a cached/blank rapid-reply result | Inline: `rapidReplyPromise` in `process()` against `this.db.rapidReply` | No (inline) |
| cancellationHandling | Let the caller abort an in-flight request | Inline: `abortControllers` map field + `cancelWatcherInterval` in `ChatCompletionProcess.ts` + module-level `isAbortError` helper (`ChatCompletionProcess.ts`) | No (inline) |

Two feature-like classes exist outside the 18-step list and outside
`ChatCompletionFeatures.ts` but are worth noting for anyone doing this extraction:
`SlackFeature`, `AutoNameSessionFeature`, `SummarizeNotebookFeature`,
`OrganizationPromptFeature`, `SessionPromptFeature`, and `KnowledgeRetrievalFeature`
(all in `ChatCompletionFeatures.ts`), and `SkillsFeature`
(`features/SkillsFeature.ts`).

### Infrastructure contracts

These are the seams `process()` currently depends on through constructor options or
direct imports. Two (`LLMBackend`, `McpClient`) are already behind a narrow
interface passed into the class; the other two proposed contracts
(`ConnectionRepository`, `ModelService`) don't exist yet - `process()` reaches
directly for a concrete sender/helper instead.

| Contract | What it abstracts | Closest thing today |
|---|---|---|
| ConnectionRepository (proposed seam) | Sending messages/status back to the connected client | No interface - `process()` constructs `ClientMessageSender` directly (from `@bike4mind/utils`) and calls `.sendToClient(...)` with `this.wsHttpsUrl` |
| LLMBackend (exists today) | Talking to a model provider | `ICompletionBackend` (from `@bike4mind/llm-adapters`), obtained via `getLlmByModel` |
| McpClient (exists today) | Connecting to an MCP server | `this.getMcpClient` field on `ChatCompletionProcess`, typed as `IChatCompletionServiceOptions['getMcpClient']` and injected via constructor options |
| MementoService (exists today) | Creating/recalling memento records | `this.invokeCreateMemento` field, injected via constructor options and used by `MementoFeature` |
| ModelService (proposed seam) | Resolving a model id to an available backend | No interface - inline calls to `getAvailableModels` / `getLlmByModel` (`@bike4mind/llm-adapters`) |
| StatusManager (exists today) | Throttled status/progress updates to the client | `StatusManager` class - `StatusManager.ts` |

## 2. Tools layer decomposition

None of the 16 provider contracts below exist in current code - there is no `Tool`
base interface and no `ToolRegistry`/`createToolRegistry`. They are a proposed
target seam set. Today, each capability is a standalone `*Tool` object exported from
its own directory under `tools/implementation/`, imported individually into
`tools/index.ts`, and assembled per-request by `ToolBuilder` (`tools/ToolBuilder.ts`)
and the `ToolManager` helpers (`tools/toolManager.ts`), with `ToolCacheManager`
(`tools/ToolCacheManager.ts`) and `ToolValidator` (`tools/ToolValidator.ts`) as
supporting infrastructure. Tool-facing types (`ToolContext`, `ToolDefinition`) live in
`tools/base/types.ts`.

There are currently 41 tool directories under `tools/implementation/` (verified via
`ls` against the stamped commit, not the ~18 figure from the earlier writeup):
`askUserQuestion`, `bashExecute`, `blogDraft`, `blogEdit`, `blogPublish`,
`chessEngine`, `createFile`, `currentDateTime`, `deepResearch`, `deleteFile`,
`diceroll`, `editFile`, `editLocalFile`, `excelGeneration`, `fileRead`, `fmp`,
`globFiles`, `grepSearch`, `imageEdit`, `imageGeneration`, `issTracker`,
`jupyterNotebook`, `knowledgeBaseRetrieve`, `knowledgeBaseSearch`, `lattice`, `math`,
`mermaidChart`, `moonPhase`, `navigateView`, `planetVisibility`, `promptEnhancement`,
`recentChanges`, `recharts`, `shellSession`, `skill`, `sunriseSunset`, `weather`,
`webfetch`, `websearch`, `wikipediaOnThisDay`, `wolfram_alpha`. (`implementation/`
also holds two agent-delegation tools as loose `.ts` files rather than their own
directories - `implementation/coordinateTask.ts` and `implementation/delegateToAgent.ts`
- so they fall outside the 41-directory count above. This enumeration rots as tools
are added; re-run `ls` against your working tree rather than trusting the list.)

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
| CodeExecutionProvider | `jupyterNotebookTool` (`tools/implementation/jupyterNotebook`, web-wired) plus `bashExecuteTool` and the `shellSession` tools (`checkShellOutputTool`, `writeShellStdinTool`, `listBackgroundShellsTool`, `killBackgroundShellTool`) - all CLI-only, wired via `tools/cliTools.ts` (`tools/implementation/bashExecute`, `tools/implementation/shellSession`) |
| ImageProvider | `imageGenerationTool`, `imageEditTool` (`tools/implementation/imageGeneration`, `imageEdit`) |
| DocumentProvider | `excelGenerationTool` (`tools/implementation/excelGeneration`) |
| BlogProvider | `blogDraftTool`, `blogEditTool`, `blogPublishTool` (`tools/implementation/blogDraft`, `blogEdit`, `blogPublish`) |
| SkillProvider | `skillTool` (`tools/implementation/skill`) |

Not mapped to a provider contract above (utility/meta tools with no obvious provider
seam): `diceRollTool`, `currentDateTimeTool`, `promptEnhancementTool`,
`navigateViewTool`, `chessEngineTool`, `recentChangesTool`, the `lattice` family, and
`askUserQuestion` - plus the two agent-delegation tools (`coordinateTask.ts`,
`delegateToAgent.ts`) and any tools supplied at runtime by premium overlay packages
(`PremiumOverlayToolName` in `tools/index.ts`).

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
