import { z } from 'zod';
import { ContextTelemetrySchema, SystemPromptDetailSchema } from './contextTelemetry';

/**
 * A Date that also accepts its own JSON form. promptMeta makes a round trip through the client:
 * MessageContent hands it to the bug-report modal, which posts it to /api/feedback, where this
 * same schema parses the request body. JSON has no Date, so a bare z.date() would reject every
 * value that survives that trip. statusLog.timestamp has carried the same allowance for years.
 */
const JsonSafeDate = z.date().or(z.string());

const PromptMetaModelParametersSchema = z.object({
  // Text generation parameters
  temperature: z.number().optional(),
  topP: z.number().optional(),
  maxTokens: z.number().optional(),
  presencePenalty: z.number().optional(),
  frequencyPenalty: z.number().optional(),
  logitBias: z.record(z.string(), z.number()).optional(),
  stream: z.boolean().optional(),

  // Image generation parameters
  n: z.number().optional(), // Number of images
  quality: z.string().optional(),
  style: z.string().optional(),
  size: z.string().optional(), // Image/video size (e.g., "1024x1024", "720x1280")
  width: z.number().optional(),
  height: z.number().optional(),
  aspect_ratio: z.string().optional(),
  safety_tolerance: z.number().optional(), // BFL safety tolerance
  prompt_upsampling: z.boolean().optional(), // BFL prompt upsampling
  seed: z.number().optional(),
  output_format: z.string().optional(), // Output format (jpeg/png)
  response_format: z.string().optional(), // Response format (url/b64_json)

  // Video generation parameters (Sora)
  seconds: z.number().optional(), // Video duration in seconds (4, 8, or 12)
  model: z.string().optional(), // Video model name
});

const PromptMetaModelSchema = z.object({
  // We're flexible about model name since they'll potentially come from Hugging Face
  // or other public sources
  name: z.string(),
  parameters: PromptMetaModelParametersSchema.optional(),
  type: z.enum(['text', 'image', 'video']).optional(),
  backend: z.string().optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
  canStream: z.boolean().optional(),
  canThink: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsImageVariation: z.boolean().optional(),
  supportsSafetyTolerance: z.boolean().optional(),
  trainingCutoff: z.string().optional(),
});

const PromptMetaTokenUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  actualInputTokens: z.number().optional(),
  actualOutputTokens: z.number().optional(),
  actualTotalTokens: z.number().optional(),
  // Billed cache-read count: raw provider value on provider-basis settlement,
  // capped-at-local-input discount value on local fallback.
  cacheReadInputTokens: z.number().optional(),
  // Billed cache-WRITE count, at the 1.25x cache-creation rate. Provider-basis only:
  // the local fallback never bills cache creation, so it stays absent there. Recorded
  // because a write is the single most expensive component of a cold turn, and without
  // it the cache-write rate can only be inferred from cacheReadInputTokens being absent.
  cacheCreationInputTokens: z.number().optional(),
  // Which basis priced estimatedCost/creditsUsed: provider-reported usage or
  // the local tokenizer estimate (fallback when the provider omits usage).
  settledBasis: z.enum(['provider', 'local']).optional(),
  estimatedCost: z.number().optional(),
  creditsUsed: z.number().optional(),
});

const PromptMetaAttachedFileSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  size: z.number().optional(),
  mimeType: z.string().optional(),
  // attachedFiles already persists, so a writer that starts setting this would hit the same
  // JSON round trip as the fields above. Promoted before that can happen rather than after.
  lastModified: JsonSafeDate.optional(),
});

const SystemPromptSourceSchema = z.object({
  fileId: z.string(),
  fileName: z.string().optional(),
  source: z.enum(['admin', 'user', 'project', 'session', 'hardcoded']),
  priority: z.number().optional(),
  enabled: z.boolean().optional(),
  content: z.string().optional(),
});

// Token breakdown by source (shared with contextTelemetry but also stored directly for overflow diagnostics)
const PromptMetaTokensBySourceSchema = z.object({
  systemPrompts: z.number(),
  conversationHistory: z.number(),
  mementos: z.number(),
  fabFiles: z.number(),
  urlContent: z.number(),
  toolSchemas: z.number(),
  userPrompt: z.number(),
});

const PromptMetaContextSchema = z.object({
  attachedFiles: z.array(PromptMetaAttachedFileSchema).optional(),
  knowledgeBaseEntries: z.array(z.string()).optional(),
  messageHistoryLength: z.number().optional(),
  requestedHistoryCount: z.number().optional(),
  totalMessageCount: z.number().optional(),
  mementoCount: z.number().optional(),
  mementoIds: z.array(z.string()).optional(),
  tokensBySource: PromptMetaTokensBySourceSchema.optional(),
  // Per-source system prompt breakdown, derived from the tagged assembly (see
  // services systemPromptSources). Stored on every completion - unlike contextTelemetry,
  // which only exists when enhanced telemetry is enabled - so the API layer can report
  // which prompts fed a completion.
  systemPromptDetails: z.array(SystemPromptDetailSchema).optional(),
  systemPrompt: z.string().optional(),
  userPrompt: z.string().optional(),
  conversationContext: z
    .array(
      z.object({
        role: z.string(),
        content: z.string(),
        timestamp: z.date().optional(),
      })
    )
    .optional(),
  // Extra context messages for external sources
  extraContextMessages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system', 'function', 'tool']),
        content: z.union([z.string(), z.array(z.any())]),
        fabFileIds: z.array(z.string()).optional(),
      })
    )
    .optional(),
  systemPromptSources: z.array(SystemPromptSourceSchema).optional(),
  dedupedSystemPrompts: z.array(z.string()).optional(),
  totalSystemPromptCount: z.number().optional(),
  duplicateSystemPromptCount: z.number().optional(),
  sessionFileIds: z.array(z.string()).optional(),
  messageFileIds: z.array(z.string()).optional(),
  globalSystemFileIds: z.array(z.string()).optional(),
  userSystemFileIds: z.array(z.string()).optional(),
  projectSystemFileIds: z.array(z.string()).optional(),
  // What the assembler decided about inlining the attached knowledge corpus vs deferring it to
  // the offered search_knowledge_base tool. Pairs with `offeredTools` + `tokensBySource.fabFiles`
  // so one row shows: tools offered, docs deferred, resulting inline token cost. `deferredCount`
  // counts only the RETRIEVABLE subset (docs the tool can actually reach); non-retrievable
  // attachments are always inlined and never counted here.
  knowledgeInlining: z
    .object({
      attachedCount: z.number(),
      retrievableCount: z.number(),
      deferredCount: z.number(),
      deferredToRetrieval: z.boolean(),
      minInlineTokensPerDoc: z.number(),
    })
    .optional(),
  // Lake memory hot-card (#1440): the durable lake-profile beliefs injected on a Data-Lake-mode turn,
  // and which lakes they came from. Present only when the card fired, so an eval row shows lake
  // grounding independent of whether the model then also called the knowledge tools.
  lakeMemory: z
    .object({
      beliefCount: z.number(),
      dataLakeTags: z.array(z.string()),
    })
    .optional(),
  // Phase 2: Context window debug fields
  contextWindowUsage: z
    .object({
      contextLimit: z.number(),
      maxOutputTokens: z.number(),
      safeMaxInputTokens: z.number(),
      actualInputTokens: z.number(),
      bufferTokens: z.number(),
      utilizationPercentage: z.number(),
      overflowDetected: z.boolean().optional(),
      overflowAmount: z.number().optional(),
      // Older turns dropped from the verbatim window this turn and folded into
      // contextSummary (drives the client's "earlier turns condensed" note).
      verbatimTurnsExcluded: z.number().optional(),
    })
    .optional(),
  // Phase 2: Message truncation tracking
  messageTruncation: z
    .object({
      wasTruncated: z.boolean(),
      originalMessageCount: z.number(),
      truncatedMessageCount: z.number(),
      truncationMethod: z.enum(['priority', 'token-budget', 'history-limit']).optional(),
      removedMessages: z
        .array(
          z.object({
            role: z.string(),
            tokens: z.number(),
            priority: z.number(),
          })
        )
        .optional(),
    })
    .optional(),
});

const PromptMetaFunctionCallSchema = z.object({
  name: z.string().optional(),
  parameters: z.record(z.string(), z.any()).optional(), // z.any() supports arrays, objects, and all JSON types
  returnValue: z.string().optional(),
  executionTime: z.number().optional(),
  success: z.boolean().optional(),
  error: z.string().optional(),
  creditsUsed: z.number().optional(),
  /** Tool use ID for Anthropic API tool pairing */
  id: z.string().optional(),
});

const PromptMetaPerformanceSchema = z.object({
  totalResponseTime: z.number().optional(),
  contextRetrievalTime: z.number().optional(),
  modelInferenceTime: z.number().optional(),
  firstTokenTime: z.number().optional(),
  clientFirstTokenTime: z.number().optional(), // Time from client sending prompt to client rendering first token
  streamingPerformance: z
    .object({
      chunkCount: z.number().optional(),
      totalStreamTime: z.number().optional(),
      totalChars: z.number().optional(),
      charsPerSecond: z.number().optional(),
    })
    .optional(),
  featureExecutionTimes: z.union([z.record(z.string(), z.number()), z.map(z.string(), z.number())]).optional(),
  databaseOperationTimes: z.union([z.record(z.string(), z.number()), z.map(z.string(), z.number())]).optional(),
  phases: z.record(z.string(), z.number()).optional(),
});

const PromptMetaSessionSchema = z.object({
  id: z.string(), // Required as per Mongoose schema
  userId: z.string(), // Required as per Mongoose schema
  organizationId: z.string().optional(),
  projectId: z.string().optional(),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
});

const PromptMetaArtifactSchema = z.object({
  // Deliberately open. Writers put internal artifact types here (`ArtifactTypeSchema`:
  // 'chess', 'react', 'html', ...) and tool extraction can fall back to a raw MIME string,
  // so a closed enum would reject real values. That matters more than usual here, because
  // ChatCompletionInvoke parses the whole promptMeta on every turn - a value this schema
  // rejects fails the completion rather than just failing to record telemetry.
  type: z.string(),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  timestamp: JsonSafeDate.optional(),
});

const ToolHealthSchema = z.object({
  toolName: z.string(),
  available: z.boolean(),
  failureCount: z.number(),
  lastError: z.string().optional(),
  lastChecked: JsonSafeDate.optional(),
  lastExecutionTime: z.number().optional(),
  successRate: z.number().optional(),
});

// Citable Source Schema - tracks sources referenced in AI responses
// Used by web_search, deep_research, RAG, and MCP tools
export const CitableSourceSchema = z.object({
  /** Unique identifier - can be URL, UUID, or composite key */
  id: z.string(),
  /** Source classification for UI rendering */
  type: z.enum(['web_url', 'document', 'dataset', 'mcp']),
  /** Human-readable title/name */
  title: z.string(),
  /** Navigation target (external URL, deep link, or hash route) */
  url: z.string().optional(),
  /** Brief description or excerpt (1-2 sentences) */
  description: z.string().optional(),
  /** ISO 8601 timestamp for freshness indication */
  timestamp: z.string().optional(),
  /** Attribution for non-report sources */
  author: z.string().optional(),
  /** Processing status for real-time updates */
  status: z.enum(['pending', 'processing', 'complete', 'error']).optional(),
  /** Extensibility metadata */
  metadata: z
    .looseObject({
      sourceSystem: z.string().optional(),
      icon: z.string().optional(),
      tags: z.array(z.string()).optional(),
      confidence: z.number().optional(),
      practiceAreas: z.array(z.string()).optional(),
      chunkId: z.string().optional(),
      relevanceScore: z.number().optional(),
      fullContext: z.string().optional(),
    }) // Allow additional properties
    .optional(),
});

/**
 * Per-turn retrieval outcome (#1867): whether retrieval was attempted this turn and what happened,
 * independent of whether the model then cited anything. Exists specifically to make the zero case
 * distinguishable from "never asked" - `context.lakeMemory` and `citables` both go silent on a
 * zero-result retrieval, so a turn that legitimately found nothing is indistinguishable from one
 * where retrieval never ran at all.
 *
 * Deliberately holds NO counts and NO chunk/document identifiers. Counts already exist and are
 * more precise: `citables.filter(c => c.type === 'document')` is deduped by id/url/title in
 * `applyQuestStatusChanges`, while this shape cannot dedupe (no identifiers to dedupe by) and
 * would have to sum - producing a second, disagreeing number for the same question. Similarity
 * scores live on `LakeAccessEvent`, not here.
 *
 * CAUTION, not a guarantee: the absence of chunk/document identifiers is what keeps this shape
 * OUT of `promptMetaRedaction.ts`'s scope (that helper is a functionCalls-only denylist and would
 * not catch a nested nonidentifier field like `dataLakeTags` regardless). It does NOT mean this
 * field never needs redaction consideration - `dataLakeTags` (which lakes were involved) already
 * reaches non-owner viewers the same way `lakeMemory.dataLakeTags` does (session shares, feedback
 * egress, admin logs, session clone - see redactedFeedback.ts, admin/model-logs.ts, clone.ts, none
 * of which touch this field). That exposure is not new in the general case, but it IS new
 * specifically on a zero-recall turn: `lakeMemory` was never written there before this field
 * existed, so a turn that previously carried no lake-identity signal at all now carries one.
 *
 * `attempted`/`outcome` on their own would still be ambiguous about WHICH lakes were searched on a
 * zero-recall turn (dataLakeTags otherwise lives only inside `lakeMemory`, written after the
 * zero-belief return), so this stamps the resolved tags at write time rather than making a reader
 * fall back to the session's current (possibly since-changed) `retrievalTags`.
 *
 * Absent-or-fully-present, matching `lakeMemory` above - see the Mongoose-side subSchema comment
 * in QuestModel.ts for why partial-write and default-array shapes are unsafe here.
 *
 * WIDER THAN ITS NAME SUGGESTS as of `mode` (#1394). The field is no longer written only when
 * retrieval ran: it is now seeded on every turn that could have retrieved (forced retrieval
 * enabled, or the knowledge tool offered), so `attempted: false` is a recorded fact rather than
 * an absence to be inferred. Presence therefore means "this turn was in a position to retrieve",
 * and turns with no knowledge in scope still carry no field at all. The distinction matters to a
 * rollup: absence is now ambiguous between "not a retrieval turn" and "written before this
 * existed", which is why `mode` documents its own date-bounding requirement.
 */
export const RetrievalSummarySchema = z.object({
  /** True once a retrieval-capable surface actually ran (not merely offered) this turn. */
  attempted: z.boolean(),
  /**
   * Present if and only if `attempted` is true - an outcome describes a run, and a turn that
   * never ran retrieval has none. A reader testing for a specific value is unaffected (absence
   * is not any of them); a reader switching exhaustively must handle undefined.
   *
   * 'ok' - ran, whether or not anything came back (the zero case is a legitimate 'ok').
   * 'no_lakes' - ran but the user had no entitled/selected lake in scope.
   * 'not_indexed' - ran to completion having compared nothing: the corpus in scope carries no
   *   usable vector (never indexed, or embedded with a foreign model), so no passage was ever
   *   scored against the query. Distinct from 'ok' because the library was not searched at all,
   *   and reporting that as a topical zero ("your documents do not cover this") is exactly the
   *   confident-wrong-answer this field exists to catch. Distinct from 'failed' because nothing
   *   broke: the remedy is re-vectorizing, which the corpus owner can do themselves, and a retry
   *   never helps.
   *   COVERAGE: recorded by forced retrieval (KnowledgeRetrievalFeature's `scoredCount === 0`
   *   exit) and by knowledgeBaseSearch, whose semantic arms carry the same verdict through to the
   *   keyword arm's write - the two agree on "not one passage was compared against the query",
   *   not on any withholding flag, so a relevance floor that emptied a real search and a partial
   *   withholding alongside a real search both stay 'ok' on both surfaces.
   *   knowledgeBaseRetrieve cannot reach this state: it fetches named files rather than ranking
   *   against a query embedding, so it has no comparison to come up empty.
   * 'failed' - recall did not complete: it threw, OR the retrieval repository is not wired on
   *   this host (the guards in ChatCompletionFeatures / knowledgeBaseSearch / knowledgeBaseRetrieve
   *   record it without anything throwing). What separates it from 'not_indexed' is the remedy,
   *   not the tempo: fix the outage or the host wiring, never re-index content. An unwired host
   *   reports continuously too, so "chronic" alone does not pick out 'not_indexed'.
   * On multiple retrieval calls within one turn, merge priority is failed > not_indexed > ok >
   * no_lakes (see retrievalSummaryMerge.ts's mergeRetrievalSummary): a single failure is never
   * masked by a later success or abstain, an unsearchable corpus outranks a legitimate zero so a
   * success on another surface cannot erase it, and a real success is never masked by another
   * surface's "no lakes in scope" abstain in the same turn.
   */
  outcome: z.enum(['ok', 'no_lakes', 'not_indexed', 'failed']).optional(),
  /**
   * Whether forced retrieval was ENABLED for this turn, independent of whether it then ran.
   *
   * This is what makes the optional path measurable. `attempted` says retrieval happened;
   * without `mode` there is no way to ask the complementary question - of the turns where the
   * model was merely OFFERED the knowledge tools, how often did it choose to retrieve - because
   * a forced turn and an optional turn both land as `attempted: true`.
   *
   * Optional on the schema, and absence NEVER means 'optional' - it means unclassified. Two
   * sources, one historical and one ongoing: turns recorded before this field landed, and
   * agent-mode runs, which write a retrieval summary through `persistRunAsQuest` but never pass
   * the seed site at the `offeredTools` write in ChatCompletionProcess. So date-bounding a rollup
   * removes the first source but not the second; count the unclassified bucket rather than
   * assuming it empties.
   */
  mode: z.enum(['forced', 'optional']).optional(),
  /**
   * Why the forced arm did not run on a turn that had it enabled. Only ever set with
   * `mode: 'forced'`, and only for the deliberate suppressions in
   * ChatCompletionFeatures.getContextMessages - a forced turn that ran and failed reports that
   * through `outcome`, not here.
   *
   * These turns are the reason this field exists: forced retrieval is configured, a rule
   * suppresses it, and the model falls back to the offered tool. That is exactly the population
   * the per-turn routing question is about, and before this it was indistinguishable from a turn
   * where forced retrieval was never configured at all.
   */
  forcedSkipReason: z.enum(['attached_files', 'personal_corpus']).optional(),
  /** Which retrieval-capable surface(s) ran this turn, e.g. 'lake-memory', 'knowledgeBaseSearch'. */
  surfaces: z.array(z.string()),
  /** Lakes resolved at the moment retrieval ran, stamped point-in-time (not read live from the session). */
  dataLakeTags: z.array(z.string()),
});

/**
 * Why a grounded turn's library scan stopped short of the whole library.
 *
 * Written ONLY on a partially-covered turn (reportCoverage returns early otherwise), so presence
 * means "partial" and `partial` is always true - the flag is explicit anyway because a reader
 * checking `retrievalCoverage.partial` should not have to know that absence is the other half of
 * the contract.
 *
 * Single producer (ChatCompletionFeatures.reportCoverage), which is why - unlike `warnings`,
 * `citables` and `retrieval` - this field needs no merge case in applyQuestStatusChanges: a
 * later tool-arm write that omits it is preserved by the one-level spread.
 *
 * `reasons` is the same diagnostic prose the warnings entry interpolates. It is shown to the
 * reader behind a disclosure rather than in the banner body, because only some reasons are
 * actionable (a document mid-reindex returns on its own; a per-turn chunk budget does not).
 */
export const RetrievalCoverageSchema = z.object({
  /** Always true - see the presence contract above. */
  partial: z.boolean(),
  /** One entry per distinct cause, e.g. a candidate cap, a scan budget, an embedding mismatch. */
  reasons: z.array(z.string()),
});

// Main PromptMeta Schema
export const PromptMetaZodSchema = z.object({
  model: PromptMetaModelSchema.optional(),
  tokenUsage: PromptMetaTokenUsageSchema.optional(),
  context: PromptMetaContextSchema.optional(),
  /** Per-turn retrieval outcome - see RetrievalSummarySchema. Top-level (not under `context`)
   * deliberately: applyQuestStatusChanges does a one-level spread merge, so a field nested under
   * `context` would be replaced wholesale by any tool-arm write instead of merging. */
  retrieval: RetrievalSummarySchema.optional(),
  /** Partial-grounding-coverage detail - see RetrievalCoverageSchema. Top-level for the same
   * one-level-spread-merge reason as `retrieval` above. */
  retrievalCoverage: RetrievalCoverageSchema.optional(),
  functionCalls: z.array(PromptMetaFunctionCallSchema).optional(),
  /**
   * Names of the tools actually offered to the model this turn - the output of `buildTools`
   * (`allTools`), after the post-build denylist pass and the Ollama auto-added trim. This is a
   * superset of the resolved `enabledTools`: it also includes MCP server tools and the
   * auto-injected `delegate_to_agent`, neither of which ever appears in `enabledTools`. Distinct
   * from the chat response's `effectiveTools`, which reflects only the API-layer (phrase-
   * recommender) selection and so cannot see server-side offers like the attached-knowledge
   * auto-offer. This is the authoritative "what did the model actually get" signal for
   * eval/measurement and for diagnosing the silent no-tool-offered state.
   */
  offeredTools: z.array(z.string()).optional(),
  performance: PromptMetaPerformanceSchema.optional(),
  session: PromptMetaSessionSchema.optional(),
  questId: z.string().optional(),
  /** ISO 8601 timestamp of when this completion's data was finalized (set at completion end). */
  generatedAt: z.string().optional(),
  promptId: z.string().optional(),
  prompt: z.string().optional(),
  replyIds: z.array(z.string()).optional(),
  generatedImageReferences: z.array(z.string()).optional(),
  promptErrors: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  /**
   * The provider's reason for ending generation (Anthropic vocabulary:
   * 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'pause_turn').
   * 'max_tokens' signals the response was truncated against the output ceiling,
   * letting the client render a truncated-artifact recovery affordance.
   */
  finishReason: z.string().optional(),
  /**
   * Set when an emitted artifact looks voluntarily abbreviated - placeholder comments in
   * place of real code, or calls into functions that were never defined. The complement to
   * `finishReason === 'max_tokens'`: truncation is a hard stop the provider reports, elision
   * finishes cleanly and reports nothing, so this is the only completeness signal available
   * for it (and the only one at all on backends that never emit a stop reason).
   * Advisory - the client renders a "may be incomplete" notice; content is never altered.
   */
  suspectedElision: z
    .object({
      confidence: z.enum(['high', 'low']),
      /** Total signals across every artifact in the reply. */
      signalCount: z.number().nonnegative(),
      /** Human-readable signal descriptions, capped for payload size. */
      details: z.array(z.string()),
    })
    .optional(),
  statusLog: z
    .array(
      z.object({
        status: z.string(),
        timestamp: z.date().or(z.string()), // z.string() is for API params stringify compatibility
      })
    )
    .optional(),
  artifacts: z.array(PromptMetaArtifactSchema).optional(),
  humanReview: z
    .object({
      required: z.boolean().optional(),
      approved: z.boolean().optional(),
      comments: z.string().optional(),
      modifications: z.string().optional(),
      reviewedBy: z.string().optional(),
      reviewedAt: JsonSafeDate.optional(),
    })
    .optional(),
  executionTracking: z
    .object({
      steps: z
        .array(
          z.object({
            name: z.string(),
            status: z.enum(['pending', 'running', 'completed', 'failed']),
            startTime: JsonSafeDate.optional(),
            endTime: JsonSafeDate.optional(),
            result: z.string().optional(),
            error: z.string().optional(),
          })
        )
        .optional(),
      currentStep: z.string().optional(),
      completedSteps: z.array(z.string()).optional(),
      failedSteps: z.array(z.string()).optional(),
    })
    .optional(),
  // Phase 2: Tool health tracking
  toolHealth: z.array(ToolHealthSchema).optional(),
  // Citable sources referenced in AI responses (from web_search, deep_research, RAG, MCP)
  citables: z.array(CitableSourceSchema).optional(),
  // Context telemetry for debugging and monitoring (privacy-first, no PII)
  contextTelemetry: ContextTelemetrySchema.optional(),
});
