/**
 * SRE Agent Service - Diagnostician
 *
 * Performs LLM-powered root cause analysis on production errors.
 * Uses a text-based tool-use loop (since getLlmByModel is a streaming
 * text completion interface, not a native tool-use API).
 *
 * Flow:
 *   1. Build system + user prompts
 *   2. Call LLM, parse tool-call blocks from response text
 *   3. Execute tools, feed results back as follow-up messages
 *   4. Repeat until diagnosis JSON is emitted or max rounds reached
 *   5. Validate diagnosis against safety rules and file scope
 */

import { type ApiKeyTable, getLlmByModel, getAvailableModels, resolveDeprecatedModelId } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { SreEventPayload, SreDiagnosis, ResolvedRepoConfig, isSreTestFile } from '@bike4mind/common';
import { z } from 'zod';
import {
  buildDiagnosticianSystemPrompt,
  buildDiagnosticianUserPrompt,
  buildRevisionUserPrompt,
  escapeCodeFences,
} from './prompts';
import { executeTool, RATE_LIMITED_SENTINEL, SreToolContext } from './tools';
import { sanitizeJsonString, sanitizeJsonStringWithMeta } from '../llm/tools/utils/jsonSanitize';

const SreDiagnosisSchema = z.object({
  rootCause: z.string(),
  proposedFix: z.string(),
  confidence: z.number().min(0).max(100),
  riskAssessment: z.string(),
  affectedFiles: z
    .array(
      z
        .object({
          filePath: z.string(),
          // For 'replace' / 'insert' before is required (non-empty); for 'create' it is
          // ignored. Enforced in the .superRefine below to keep the per-kind contract
          // explicit and to give a focused error message.
          before: z.string(),
          after: z.string(),
          // 'insert' lets the LLM express additive edits via anchor-replace; 'create'
          // bootstraps a brand-new file. See prompts.ts "Additive Edits" / "Creating New Files".
          kind: z.enum(['insert', 'replace', 'create']).default('replace'),
        })
        .superRefine((file, ctx) => {
          if (file.kind !== 'create' && file.before.length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['before'],
              message: `"before" is required for kind="${file.kind}" hunks`,
            });
          }
        })
    )
    // Raised from 10 to accommodate helper+multi-site refactors that emit
    // one insert hunk plus N replace hunks.
    .max(15),
  // Recurrence escalation fields - populated when the Diagnostician judges its
  // proposed fix would be another incremental tuning of a previously failed
  // workaround. Handler routes to the escalation path when escalate=true.
  escalate: z.boolean().optional(),
  rootCauseTrackingIssue: z.number().int().positive().optional(),
});

/** Dangerous patterns that must never appear in proposed code */
const DANGEROUS_PATTERNS = [
  /\beval\s*\(/,
  /\bchild_process\b/,
  /\bexec\s*\(/,
  /\bexecSync\s*\(/,
  /\bspawnSync\s*\(/,
  /\bspawn\s*\(/,
  /\bFunction\s*\(/,
  /\brequire\s*\(\s*['"]child/,
  /\bimport\s.*['"]child_process/,
  /\bprocess\.env\s*\[/,
  /\bfs\s*\.\s*unlinkSync\s*\(/,
  /\bfs\s*\.\s*rmdirSync\s*\(/,
  /\bfs\s*\.\s*rmSync\s*\(/,
  /\bfs\s*\.\s*writeFileSync\s*\(\s*['"]\/(?:etc|usr|var)/,
  /\bvm\s*\.\s*runInNewContext\s*\(/,
  /\bvm\s*\.\s*createScript\s*\(/,
  /\bWebSocket\s*\(/,
  /\bnew\s+Proxy\s*\(/,
];

/** Max tool-use rounds before forcing final output */
const MAX_TOOL_ROUNDS = 8;

/** Max tool call blocks to parse from a single LLM response - defense against LLM spam */
const MAX_TOOL_CALLS_PER_RESPONSE = 10;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Optional pattern library interface - decoupled from database layer */
export interface SrePatternLookup {
  findMatch(fingerprint: string, minConfidence: number): Promise<SreDiagnosis | null>;
  recordMatch(fingerprint: string): Promise<void>;
}

/** Structured trace entry for dry-run debugging */
export interface DryRunTraceEntry {
  step: string;
  data: Record<string, unknown>;
  ts: number;
}

/** Result from the diagnose method - includes failure reason when diagnosis is null */
export interface DiagnoseResult {
  diagnosis: SreDiagnosis | null;
  failureReason?: string;
  /** When set, the LLM identified a root cause but all fix files are outside allowed scope */
  scopeBlocked?: {
    blockedFiles: string[];
    diagnosis: SreDiagnosis;
  };
  /** Structured trace entries collected during dry-run execution */
  dryRunTrace?: DryRunTraceEntry[];
  /** When true, the revised diagnosis is identical to the original - no point pushing the same fix */
  noChange?: boolean;
  /** When true, truncation repair was applied to the diagnosis JSON (streaming abort) */
  truncationRepaired?: boolean;
}

/** Context for a revision request - passed to diagnose() to use revision prompts */
export interface RevisionContext {
  originalDiagnosis: SreDiagnosis;
  reviewFeedback: string;
  /** CI failure output to feed back as context data (apply-fix or typecheck failure) */
  ciFailureOutput?: string;
}

/** Max forced-diagnosis retry attempts before giving up */
const MAX_FORCED_DIAGNOSIS_ATTEMPTS = 2;

/** Absolute hard cap on total LLM calls - defense-in-depth against unbounded retries */
const MAX_TOTAL_LLM_CALLS = 14;

/** Confidence cap applied when a diagnosis is accepted with zero successful tool calls */
const ZERO_TOOL_CONFIDENCE_CAP = 5;

/** Forced-diagnosis prompt for LLMs that have already gathered information via tools */
const FORCED_DIAGNOSIS_PROMPT =
  'You have gathered enough information. Output your final diagnosis NOW using the ```diagnosis JSON format. Use the information you have already gathered. Any ```tool blocks will be IGNORED — only a ```diagnosis block will be accepted.';

/** Escalated forced-diagnosis prompt with JSON skeleton for non-compliant LLMs */
const FORCED_DIAGNOSIS_SKELETON_PROMPT =
  'You MUST output your diagnosis NOW. Any ```tool blocks will be IGNORED — only a ```diagnosis block will be accepted. Respond with ONLY the following block, filled in:\n\n```diagnosis\n{"rootCause": "...", "proposedFix": "...", "confidence": <your_estimate>, "riskAssessment": "...", "affectedFiles": []}\n```';

export class SreAgentService {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /** Accumulated trace entries for dry-run document storage */
  private traceLog: DryRunTraceEntry[] = [];

  /** Emit structured trace log for dry-run debugging. No-op when isDryRun is false. */
  private trace(isDryRun: boolean, step: string, data: Record<string, unknown>, fingerprint: string): void {
    if (!isDryRun) return;
    this.logger.info('[DRY-RUN-TRACE]', { step, fingerprint, ...data });
    this.traceLog.push({ step, data, ts: Date.now() });
  }

  async diagnose(
    payload: SreEventPayload,
    config: ResolvedRepoConfig,
    apiKeyTable: ApiKeyTable,
    toolContext: SreToolContext,
    patternLookup?: SrePatternLookup,
    dryRun?: boolean,
    issueComments?: string,
    revisionContext?: RevisionContext,
    priorFixHistory?: Array<{ prNumber: number; mergedAt: string; proposedFix: string }>
  ): Promise<DiagnoseResult> {
    const isDryRun = dryRun ?? false;
    // Rule 2 - CI self-heal is source-only. When revising in response to a
    // recoverable CI failure (test/typecheck/apply-fix), the bot is iterating on a
    // red run; it must never edit a test to make it pass. Block all test files in
    // this path so a fix that can only go green by editing a test escalates instead.
    // Presence check (not truthiness): the field is absent only for human-review
    // revisions, so an empty-string output is still a CI self-heal and must block tests.
    const blockTestFiles = revisionContext?.ciFailureOutput != null;
    this.traceLog = [];
    /** Attach collected trace entries to the result when in dry-run mode */
    const withTrace = (result: DiagnoseResult): DiagnoseResult =>
      isDryRun && this.traceLog.length > 0 ? { ...result, dryRunTrace: this.traceLog } : result;
    try {
      // 0. Check pattern library for cached diagnosis (skip for revisions - always need fresh LLM analysis)
      if (config.patternLibrary.enabled && patternLookup && !revisionContext) {
        const cached = await patternLookup.findMatch(payload.fingerprint, config.patternLibrary.minConfidence);
        this.trace(
          isDryRun,
          'pattern-library-check',
          {
            enabled: true,
            hit: !!cached,
            cachedConfidence: cached?.confidence ?? null,
          },
          payload.fingerprint
        );
        if (cached) {
          this.logger.info('[SRE-DIAGNOSTICIAN] Pattern library HIT — skipping LLM', {
            fingerprint: payload.fingerprint,
            confidence: cached.confidence,
          });
          await patternLookup.recordMatch(payload.fingerprint);
          return withTrace({ diagnosis: cached });
        }
        this.logger.info('[SRE-DIAGNOSTICIAN] Pattern library MISS', { fingerprint: payload.fingerprint });
      } else {
        this.trace(
          isDryRun,
          'pattern-library-check',
          {
            enabled: config.patternLibrary.enabled,
            hit: false,
            cachedConfidence: null,
          },
          payload.fingerprint
        );
      }

      // 1. Build prompts
      const systemPrompt = buildDiagnosticianSystemPrompt({
        allowedFilePatterns: config.allowedFilePatterns,
        blockedFilePatterns: config.blockedFilePatterns,
        maxDiffLines: config.maxDiffLines,
        sreInstructions: config.sreInstructions,
      });
      const userPrompt = revisionContext
        ? buildRevisionUserPrompt(
            payload,
            revisionContext.originalDiagnosis,
            revisionContext.reviewFeedback,
            revisionContext.ciFailureOutput
          )
        : buildDiagnosticianUserPrompt(payload, { issueComments, priorFixHistory });

      this.trace(
        isDryRun,
        'prompts-built',
        {
          systemPromptLength: systemPrompt.length,
          userPromptLength: userPrompt.length,
        },
        payload.fingerprint
      );

      // 2. Get LLM backend
      const modelId = resolveDeprecatedModelId(config.modelId, 'sreAgentService');
      const modelInfo = (await getAvailableModels(apiKeyTable)).find(m => m.id === modelId);
      if (!modelInfo) {
        this.logger.error('[SRE-DIAGNOSTICIAN] Model not available', { modelId });
        return withTrace({ diagnosis: null, failureReason: 'Model not available' });
      }

      const llm = getLlmByModel(apiKeyTable, { modelInfo, logger: this.logger });
      if (!llm) {
        this.logger.error('[SRE-DIAGNOSTICIAN] Failed to initialize LLM backend', { modelId });
        return withTrace({ diagnosis: null, failureReason: 'Failed to initialize LLM backend' });
      }

      this.trace(
        isDryRun,
        'model-selected',
        {
          modelId,
          modelFound: true,
          llmInitialized: true,
        },
        payload.fingerprint
      );

      // 3. Tool-use loop
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ];

      const toolCallLog: Array<{ tool: string; input: Record<string, unknown>; output: string }> = [];
      let successfulToolCalls = 0;
      let forcedDiagnosisAttempts = 0;
      let rejectedZeroToolDiagnosis = false;
      let retriedParseDiagnosis = false;
      let skipTestFileCheckOnRetry = false;
      let totalLlmCalls = 0;
      /** Tracks out-of-scope files across attempts for scope-blocked detection */
      let scopeBlockedFiles: string[] = [];
      /** Stashed diagnosis from first scope-violation attempt (used if retry also fails) */
      let scopeBlockedDiagnosis: SreDiagnosis | null = null;

      /**
       * Emergency context-reset diagnosis: a single, minimal LLM call that
       * bypasses tool descriptions and forces the model to emit a strict JSON
       * diagnosis. Last-resort recovery when the primary tool-use loop cannot
       * produce a valid diagnosis - either by exhausting forced-diagnosis
       * attempts or by returning a malformed/Zod-failing diagnosis on both
       * first attempt and retry.
       *
       * Returns null on any failure (LLM, parse, or schema). Callers are
       * responsible for budget checks (totalLlmCalls) and for logging the
       * "Attempting emergency context-reset diagnosis" warn line so failure
       * mode is visible in logs.
       */
      const tryEmergencyDiagnosis = async (): Promise<{
        diagnosis: SreDiagnosis;
        truncationRepaired?: boolean;
      } | null> => {
        try {
          const rawToolSummary =
            toolCallLog.length > 0
              ? toolCallLog
                  .map(e => `[${e.tool}(${JSON.stringify(e.input)})] → ${e.output.slice(0, 300)}`)
                  .join('\n---\n')
              : '(no tool investigation was performed)';
          // Cap total summary size to keep emergency prompt within token budget.
          // Tail-slice (-3000) keeps the most-recent tool calls, which are most relevant
          // for the emergency context (earlier rounds explored, later rounds zeroed in on the issue).
          const toolSummary = rawToolSummary.length > 3000 ? rawToolSummary.slice(-3000) : rawToolSummary;

          const emergencySystemPrompt =
            'You are a code diagnosis engine. Output ONLY a valid JSON object. No markdown, no code blocks, no preamble. The confidence field is a 0–100 score; if unsure, use a value under 20 and an empty affectedFiles array.';
          const emergencyUserPrompt = `Error: ${escapeCodeFences(payload.errorMessage)}\nStack: ${escapeCodeFences((payload.stackTrace ?? '').slice(0, 500))}\n\nInvestigation findings:\n${escapeCodeFences(toolSummary)}\n\nOutput JSON (all fields required):\n{"rootCause":"...","proposedFix":"...","confidence":<0-100>,"riskAssessment":"...","affectedFiles":[]}`;

          let emergencyResponse = '';
          await llm.complete(
            modelId,
            [
              { role: 'system', content: emergencySystemPrompt },
              { role: 'user', content: emergencyUserPrompt },
            ],
            { temperature: 0.2, maxTokens: config.tokenBudget.maxOutputTokens },
            async texts => {
              emergencyResponse += texts.join('');
            }
          );

          // Strip accidental markdown fences
          const stripped = emergencyResponse
            .replace(/^```(?:json|diagnosis)?\s*/i, '')
            .replace(/\s*```\s*$/, '')
            .trim();

          const { result: sanitized, truncationRepaired } = sanitizeJsonStringWithMeta(stripped, {
            attemptTruncationRepair: true,
          });
          if (truncationRepaired) {
            this.logger.warn('[SRE-DIAGNOSTICIAN] Truncation repair applied to emergency diagnosis JSON');
          }

          const emergencyParsed = JSON.parse(sanitized);
          const emergencyValidated = SreDiagnosisSchema.parse(emergencyParsed);

          // Safety: emergency path skips parseDiagnosis() scope/safety checks.
          // Force empty affectedFiles - the emergency diagnosis is informational only;
          // any fix will be generated by a subsequent revision with full validation.
          emergencyValidated.affectedFiles = [];

          if (successfulToolCalls === 0) {
            emergencyValidated.confidence = Math.min(emergencyValidated.confidence, ZERO_TOOL_CONFIDENCE_CAP);
          }
          emergencyValidated.confidence = Math.min(emergencyValidated.confidence, 95);

          this.logger.info('[SRE-DIAGNOSTICIAN] Emergency context-reset diagnosis succeeded', {
            confidence: emergencyValidated.confidence,
          });
          return { diagnosis: emergencyValidated, truncationRepaired };
        } catch (emergencyError) {
          this.logger.warn('[SRE-DIAGNOSTICIAN] Emergency context-reset diagnosis failed', {
            error: emergencyError instanceof Error ? emergencyError.message : String(emergencyError),
          });
          return null;
        }
      };

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        this.trace(
          isDryRun,
          'loop-iteration-start',
          {
            round: round + 1,
            totalLlmCalls,
            messageCount: messages.length,
            forcedDiagnosisAttempts,
            rejectedZeroToolDiagnosis,
            retriedParseDiagnosis,
            toolCallCount: toolCallLog.length,
          },
          payload.fingerprint
        );

        // Absolute hard cap - prevents unbounded retries from round-- interactions
        if (++totalLlmCalls > MAX_TOTAL_LLM_CALLS) {
          this.logger.error('[SRE-DIAGNOSTICIAN] Absolute LLM call cap reached', {
            totalLlmCalls,
            round: round + 1,
            forcedDiagnosisAttempts,
          });
          break;
        }

        this.logger.info('[SRE-DIAGNOSTICIAN] LLM round', { round: round + 1, messageCount: messages.length });

        let responseContent = '';
        await llm.complete(
          modelId,
          messages,
          {
            temperature: 0.2,
            maxTokens: config.tokenBudget.maxOutputTokens,
          },
          async texts => {
            responseContent += texts.join('');
          }
        );

        this.trace(
          isDryRun,
          'llm-response',
          {
            round: round + 1,
            responseLength: responseContent.length,
            responsePreview: responseContent.slice(0, 500),
          },
          payload.fingerprint
        );

        // Zero-tool guard: reject diagnosis if LLM hasn't investigated yet.
        // Returns 'reject' (re-prompt), 'accept-warn' (second attempt), or 'ok'.
        const checkZeroToolGuard = (label: string): 'reject' | 'accept-warn' | 'ok' => {
          const noUsefulData =
            (toolCallLog.length === 0 || successfulToolCalls === 0) && toolContext.apiCallCounter.max > 0;
          if (noUsefulData) {
            if (!rejectedZeroToolDiagnosis) {
              rejectedZeroToolDiagnosis = true;
              this.logger.warn(`[SRE-DIAGNOSTICIAN] Rejected zero-tool ${label}, forcing investigation`, {
                round: round + 1,
                fingerprint: payload.fingerprint,
                toolCallLogLength: toolCallLog.length,
                successfulToolCalls,
              });
              return 'reject';
            }
            this.logger.warn(`[SRE-DIAGNOSTICIAN] Accepting zero-tool ${label} on second attempt`, {
              round: round + 1,
              toolCallLogLength: toolCallLog.length,
              successfulToolCalls,
            });
            return 'accept-warn';
          }
          return 'ok';
        };

        const rejectAndReprompt = (content: string) => {
          messages.push({ role: 'assistant', content });
          messages.push({
            role: 'user',
            content:
              'Your diagnosis was rejected because you did not investigate the codebase. You MUST use at least one tool (github_code_search or github_file_read) to examine the actual source code before diagnosing. Search for code related to this error now.',
          });
        };

        // Parse both tool calls and diagnosis upfront - decision matrix handles priority
        const toolCalls = this.parseToolCalls(responseContent);
        const diagnosisMatch = responseContent.match(/```diagnosis\s*([\s\S]*?)```/);

        // Fabrication detection: tool calls + diagnosis in the same response
        if (toolCalls.length > 0 && diagnosisMatch) {
          const budgetExhaustedNow = toolContext.apiCallCounter.count >= toolContext.apiCallCounter.max;
          const isForcedDiagnosis = forcedDiagnosisAttempts > 0;
          const acceptDiagnosis = budgetExhaustedNow || isForcedDiagnosis;

          this.trace(
            isDryRun,
            'fabrication-detected',
            {
              round: round + 1,
              toolCount: toolCalls.length,
              diagnosisDiscarded: !acceptDiagnosis,
              reason: acceptDiagnosis
                ? budgetExhaustedNow
                  ? 'budget-exhausted'
                  : 'forced-diagnosis-active'
                : 'premature-diagnosis-with-tools',
              responsePreview: responseContent.slice(0, 500),
            },
            payload.fingerprint
          );

          this.logger.warn('[SRE-DIAGNOSTICIAN] Tool calls + diagnosis in same response (fabrication)', {
            round: round + 1,
            toolCount: toolCalls.length,
            accepted: acceptDiagnosis,
            reason: acceptDiagnosis
              ? budgetExhaustedNow
                ? 'budget-exhausted'
                : 'forced-diagnosis-active'
              : 'discarded-premature-diagnosis',
          });

          // When !acceptDiagnosis, the premature diagnosis is discarded - fall through
          // to tool execution below. shouldProcessDiagnosis evaluates to false.
        }

        // Decision: process diagnosis if present AND (no tool calls OR diagnosis is accepted)
        const shouldProcessDiagnosis =
          diagnosisMatch &&
          (toolCalls.length === 0 ||
            toolContext.apiCallCounter.count >= toolContext.apiCallCounter.max ||
            forcedDiagnosisAttempts > 0);

        if (shouldProcessDiagnosis) {
          const guard = checkZeroToolGuard('diagnosis');
          this.trace(
            isDryRun,
            'zero-tool-guard',
            {
              guardResult: guard,
              toolCallCount: toolCallLog.length,
              apiCallCounterMax: toolContext.apiCallCounter.max,
            },
            payload.fingerprint
          );
          if (guard === 'reject') {
            this.trace(
              isDryRun,
              'branch-taken',
              { round: round + 1, branch: 'zero-tool-reprompt' },
              payload.fingerprint
            );
            rejectAndReprompt(responseContent);
            continue;
          }
          this.trace(isDryRun, 'branch-diagnosis-found', { round: round + 1 }, payload.fingerprint);
          this.logger.info('[SRE-DIAGNOSTICIAN] Diagnosis block found', { round: round + 1 });
          const parseResult = await this.parseDiagnosis(diagnosisMatch![1], config, toolCallLog, toolContext, {
            skipTestFileCheck: skipTestFileCheckOnRetry,
            blockTestFiles,
          });
          this.trace(
            isDryRun,
            'diagnosis-parse',
            {
              success: !!parseResult.result,
              error: parseResult.error ?? null,
              confidence: parseResult.result?.confidence ?? null,
              affectedFileCount: parseResult.result?.affectedFiles?.length ?? null,
            },
            payload.fingerprint
          );
          if (parseResult.result) {
            // Zero-tool diagnoses are unreliable - hard-cap confidence so they never
            // pass the gate. The diagnosis is still recorded for operator visibility.
            if (guard === 'accept-warn') {
              this.logger.warn('[SRE-DIAGNOSTICIAN] Capping zero-tool diagnosis confidence', {
                original: parseResult.result.confidence,
                capped: ZERO_TOOL_CONFIDENCE_CAP,
              });
              parseResult.result.confidence = Math.min(parseResult.result.confidence, ZERO_TOOL_CONFIDENCE_CAP);
            }
            // After scope-violation retry: if LLM returned empty affectedFiles, it means
            // no in-scope fix is possible - return scope-blocked with the original diagnosis
            if (
              scopeBlockedFiles.length > 0 &&
              scopeBlockedDiagnosis &&
              parseResult.result.affectedFiles.length === 0
            ) {
              this.trace(
                isDryRun,
                'scope-blocked',
                {
                  blockedFiles: scopeBlockedFiles,
                  confidence: parseResult.result.confidence,
                  rootCausePreview: parseResult.result.rootCause.slice(0, 200),
                },
                payload.fingerprint
              );
              // Use the retry's diagnosis (has updated confidence based on root cause certainty)
              return withTrace({
                diagnosis: null,
                scopeBlocked: { blockedFiles: scopeBlockedFiles, diagnosis: parseResult.result },
              });
            }
            // Diff delta check for revisions: abort if the fix is identical to the original
            if (revisionContext && parseResult.result.affectedFiles.length > 0) {
              const originalFiles = revisionContext.originalDiagnosis.affectedFiles;
              const revisedFiles = parseResult.result.affectedFiles;
              const isIdentical =
                originalFiles.length === revisedFiles.length &&
                originalFiles.every((orig, i) => {
                  const rev = revisedFiles[i];
                  return (
                    rev &&
                    orig.filePath === rev.filePath &&
                    orig.before === rev.before &&
                    orig.after === rev.after &&
                    (orig.kind ?? 'replace') === (rev.kind ?? 'replace')
                  );
                });
              if (isIdentical) {
                this.logger.warn('[SRE-DIAGNOSTICIAN] Revision produced identical fix — aborting', {
                  fingerprint: payload.fingerprint,
                });
                return withTrace({
                  diagnosis: null,
                  failureReason: 'Revision produced identical fix to original — no progress made',
                  noChange: true,
                });
              }
            }
            return withTrace({
              diagnosis: parseResult.result,
              truncationRepaired: parseResult.truncationRepaired,
            });
          }

          // Parse failed - check if this is a scope violation or a generic parse error
          const isScopeViolation = parseResult.error?.startsWith('Files not in allowed scope:');

          if (!retriedParseDiagnosis) {
            retriedParseDiagnosis = true;

            if (isScopeViolation) {
              // Extract blocked file paths and stash the diagnosis for scope-blocked detection
              const blockedFileStr = parseResult.error!.replace('Files not in allowed scope: ', '');
              scopeBlockedFiles = blockedFileStr.split(', ');
              // Re-parse the raw JSON to capture the full diagnosis (before scope validation rejected it).
              // `attemptTruncationRepair: true` matches parseDiagnosis() so a truncated diagnosis block
              // that parseDiagnosis successfully extracted scope-violating files from is also recoverable here.
              try {
                const rawParsed = JSON.parse(
                  sanitizeJsonStringWithMeta(diagnosisMatch![1].trim(), { attemptTruncationRepair: true }).result
                );
                const rawValidated = SreDiagnosisSchema.parse(rawParsed);
                rawValidated.confidence = Math.min(rawValidated.confidence, 95);
                scopeBlockedDiagnosis = { ...rawValidated, toolCalls: toolCallLog };
              } catch {
                // If re-parse fails, we can't stash - proceed with generic retry
              }

              this.logger.warn('[SRE-DIAGNOSTICIAN] Scope violation, re-prompting with scope-specific guidance', {
                round: round + 1,
                blockedFiles: scopeBlockedFiles,
              });
              messages.push({ role: 'assistant', content: responseContent });
              messages.push({
                role: 'user',
                content: `Your diagnosis included files outside the allowed modification scope: ${scopeBlockedFiles.join(', ')}\nAllowed patterns: ${config.allowedFilePatterns.join(', ')}\n\nIf there is an alternative fix targeting only files within the allowed scope, produce a new diagnosis with those files.\nIf NO in-scope fix is possible, produce a diagnosis with an empty affectedFiles array. Set confidence based on your certainty in the ROOT CAUSE analysis, not whether an auto-fix is possible.`,
              });
            } else if (parseResult.error?.includes('but did not include them in affectedFiles')) {
              this.logger.warn('[SRE-DIAGNOSTICIAN] Test file read but not in affectedFiles, re-prompting', {
                round: round + 1,
              });
              skipTestFileCheckOnRetry = true;
              messages.push({ role: 'assistant', content: responseContent });
              messages.push({
                role: 'user',
                content: `${parseResult.error}\n\nPlease re-emit your diagnosis. Either:\n1. Include the test file(s) in affectedFiles with updated assertions matching your fix, OR\n2. If no test assertions need updating, re-emit the same diagnosis and add to proposedFix an explanation of why the test file does not need changes.`,
              });
            } else if (parseResult.error?.includes('Before-block uniqueness check failed')) {
              this.logger.warn('[SRE-DIAGNOSTICIAN] Before-block uniqueness failed, re-prompting', {
                round: round + 1,
              });
              messages.push({ role: 'assistant', content: responseContent });
              messages.push({
                role: 'user',
                content: `${parseResult.error}\n\nIf the file was truncated when you read it and you cannot see the code you want to modify, use github_code_search to locate the EXACT text — then copy it verbatim (no rephrasing, no reformatting) into your "before" field. Otherwise, include more surrounding context (function name, preceding comment, neighboring lines) to make each "before" block match exactly once.`,
              });
            } else if (parseResult.error?.includes('Diff too large')) {
              this.logger.warn('[SRE-DIAGNOSTICIAN] Diff too large, re-prompting', { round: round + 1 });
              messages.push({ role: 'assistant', content: responseContent });
              messages.push({
                role: 'user',
                content: `${parseResult.error}\n\nPlease re-emit your diagnosis with a smaller scope. Focus on the most critical fix only — remove less important changes from affectedFiles.`,
              });
            } else {
              this.logger.warn('[SRE-DIAGNOSTICIAN] Diagnosis JSON malformed, re-prompting', { round: round + 1 });
              const isUnterminatedString =
                parseResult.error?.toLowerCase().includes('unterminated string') ||
                parseResult.error?.toLowerCase().includes('bad control character');
              const escapingGuidance = isUnterminatedString
                ? `\n\nIMPORTANT: The error indicates an unescaped double-quote character (") inside a JSON string value. In JSON, every " within a string MUST be escaped as \\". For example, code like logger.error("msg", err) must be written as "logger.error(\\"msg\\", err)" in your JSON. Audit every "before" and "after" field for bare double-quotes and escape them.`
                : '';
              messages.push({ role: 'assistant', content: responseContent });
              messages.push({
                role: 'user',
                content: `Your diagnosis JSON was malformed. Error: ${parseResult.error}${escapingGuidance}\n\nPlease output it again using this exact structure:\n\n\`\`\`diagnosis\n{"rootCause": "...", "proposedFix": "...", "confidence": 0, "riskAssessment": "...", "affectedFiles": []}\n\`\`\``,
              });
            }
            // Don't count this retry against MAX_TOOL_ROUNDS (hard cap: MAX_TOTAL_LLM_CALLS)
            round--;
            continue;
          }

          // Second attempt also failed - check for scope-blocked terminal state.
          // Three sources of `scopeBlockedDiagnosis` are handled together here:
          //   1. First attempt was a scope violation that re-parsed cleanly into the stash
          //      (existing behavior since this path was added).
          //   2. First attempt was a non-scope error (e.g., malformed JSON, before-block
          //      uniqueness) and the SECOND attempt is the scope violation - stash now so
          //      the run terminates as `scope_blocked` rather than `failed`.
          //   3. First attempt was a scope violation whose re-parse failed silently in the
          //      first-attempt try/catch (so `scopeBlockedFiles` was populated but
          //      `scopeBlockedDiagnosis` was not); a successful re-parse on the second
          //      attempt lets us still return scope-blocked. With both inline re-parse
          //      sites now passing `attemptTruncationRepair: true` (matching parseDiagnosis)
          //      this path is defensive - the only remaining divergence vector would be a
          //      Zod-schema or JSON.parse failure that parseDiagnosis already accepted,
          //      which shouldn't happen. We MERGE the second attempt's blocked files into
          //      the existing set rather than overwriting, so the operator sees every file
          //      the LLM tried to touch.
          if (isScopeViolation && !scopeBlockedDiagnosis) {
            const blockedFileStr = parseResult.error!.replace('Files not in allowed scope: ', '');
            for (const f of blockedFileStr.split(', ')) {
              if (!scopeBlockedFiles.includes(f)) scopeBlockedFiles.push(f);
            }
            try {
              const rawParsed = JSON.parse(
                sanitizeJsonStringWithMeta(diagnosisMatch![1].trim(), { attemptTruncationRepair: true }).result
              );
              const rawValidated = SreDiagnosisSchema.parse(rawParsed);
              rawValidated.confidence = Math.min(rawValidated.confidence, 95);
              scopeBlockedDiagnosis = { ...rawValidated, toolCalls: toolCallLog };
            } catch {
              // Re-parse failed on the second attempt too - fall through to the emergency
              // fallback / generic failure path below. Without a parseable diagnosis we
              // can't return a meaningful scope_blocked result.
            }
          }

          if (scopeBlockedFiles.length > 0 && scopeBlockedDiagnosis) {
            if (isScopeViolation) {
              // Accumulate new blocked files from second attempt
              const newBlockedStr = parseResult.error!.replace('Files not in allowed scope: ', '');
              const newBlocked = newBlockedStr.split(', ');
              for (const f of newBlocked) {
                if (!scopeBlockedFiles.includes(f)) scopeBlockedFiles.push(f);
              }
            }
            this.trace(
              isDryRun,
              'scope-blocked',
              {
                blockedFiles: scopeBlockedFiles,
                confidence: scopeBlockedDiagnosis.confidence,
                rootCausePreview: scopeBlockedDiagnosis.rootCause.slice(0, 200),
              },
              payload.fingerprint
            );
            return withTrace({
              diagnosis: null,
              scopeBlocked: { blockedFiles: scopeBlockedFiles, diagnosis: scopeBlockedDiagnosis },
            });
          }

          // Last-resort recovery: the loop produced a diagnosis block but it
          // failed parse/validate on both attempts (e.g., LLM emitted required
          // fields as null/undefined). Try the emergency
          // context-reset path before giving up.
          if (totalLlmCalls < MAX_TOTAL_LLM_CALLS) {
            totalLlmCalls++;
            this.logger.warn('[SRE-DIAGNOSTICIAN] Attempting emergency context-reset diagnosis after retry failure', {
              totalLlmCalls,
              parseError: parseResult.error?.slice(0, 200),
            });
            const emergencyResult = await tryEmergencyDiagnosis();
            if (emergencyResult) {
              return withTrace({
                diagnosis: { ...emergencyResult.diagnosis, toolCalls: toolCallLog },
                truncationRepaired: emergencyResult.truncationRepaired,
              });
            }
          }

          return withTrace({
            diagnosis: null,
            failureReason: `Diagnosis failed after retry: ${parseResult.error}`,
          });
        }

        // No tool calls found (and no diagnosis handled above)
        if (toolCalls.length === 0) {
          this.trace(
            isDryRun,
            'branch-no-tools-no-diagnosis',
            {
              round: round + 1,
              hasRawJson: /\{[\s\S]*\}/.test(responseContent),
              toolCallLogLength: toolCallLog.length,
              apiCallCounterMax: toolContext.apiCallCounter.max,
              rejectedZeroToolDiagnosis,
            },
            payload.fingerprint
          );
          // No tool calls and no diagnosis - try to parse as raw JSON
          const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const guard = checkZeroToolGuard('raw JSON diagnosis');
            if (guard === 'reject') {
              rejectAndReprompt(responseContent);
              continue;
            }
            this.logger.info('[SRE-DIAGNOSTICIAN] Attempting raw JSON parse', { round: round + 1 });
            const parseResult = await this.parseDiagnosis(jsonMatch[0], config, toolCallLog, toolContext, {
              skipTestFileCheck: skipTestFileCheckOnRetry,
              blockTestFiles,
            });
            if (parseResult.result) {
              if (guard === 'accept-warn') {
                this.logger.warn('[SRE-DIAGNOSTICIAN] Capping zero-tool diagnosis confidence', {
                  original: parseResult.result.confidence,
                  capped: ZERO_TOOL_CONFIDENCE_CAP,
                });
                parseResult.result.confidence = Math.min(parseResult.result.confidence, ZERO_TOOL_CONFIDENCE_CAP);
              }
              return withTrace({
                diagnosis: parseResult.result,
                truncationRepaired: parseResult.truncationRepaired,
              });
            }
            return withTrace({
              diagnosis: null,
              failureReason: `Raw JSON diagnosis parse failed: ${parseResult.error}`,
            });
          }

          // Re-prompt once if no tools used yet
          if (toolCallLog.length === 0 && toolContext.apiCallCounter.max > 0 && !rejectedZeroToolDiagnosis) {
            rejectedZeroToolDiagnosis = true;
            this.logger.warn('[SRE-DIAGNOSTICIAN] No tools or diagnosis, re-prompting for investigation', {
              round: round + 1,
            });
            messages.push({ role: 'assistant', content: responseContent });
            messages.push({
              role: 'user',
              content:
                'You did not call any tools or produce a diagnosis. You MUST use at least one tool to investigate the codebase. Use github_code_search to search for code related to this error.',
            });
            continue;
          }

          // LLM produced text with no tool calls and no diagnosis block.
          // If tools have been used, force diagnosis instead of giving up -
          // the LLM has gathered info but failed to format it as a diagnosis.
          if (toolCallLog.length > 0) {
            if (forcedDiagnosisAttempts >= MAX_FORCED_DIAGNOSIS_ATTEMPTS) {
              this.trace(
                isDryRun,
                'branch-taken',
                { round: round + 1, branch: 'text-only-force-diagnosis-exhausted' },
                payload.fingerprint
              );
              this.logger.warn('[SRE-DIAGNOSTICIAN] LLM ignored forced diagnosis (text response)', {
                round: round + 1,
                attempts: forcedDiagnosisAttempts,
              });
              break;
            }
            this.trace(
              isDryRun,
              'branch-taken',
              { round: round + 1, branch: 'text-only-force-diagnosis' },
              payload.fingerprint
            );
            this.logger.warn('[SRE-DIAGNOSTICIAN] No diagnosis block in response, forcing diagnosis', {
              round: round + 1,
            });
            forcedDiagnosisAttempts++;
            messages.push({ role: 'assistant', content: responseContent });
            messages.push({ role: 'user', content: FORCED_DIAGNOSIS_PROMPT });
            // Don't count against MAX_TOOL_ROUNDS (hard cap: MAX_TOTAL_LLM_CALLS)
            round--;
            continue;
          }
          // No tools ever used, no diagnosis block - force diagnosis rather than giving up.
          // The zero-tool confidence cap (5) ensures these never pass the gate.
          if (forcedDiagnosisAttempts < MAX_FORCED_DIAGNOSIS_ATTEMPTS) {
            this.trace(
              isDryRun,
              'branch-taken',
              { round: round + 1, branch: 'zero-tool-force-diagnosis' },
              payload.fingerprint
            );
            this.logger.warn('[SRE-DIAGNOSTICIAN] No tools or diagnosis, forcing diagnosis output', {
              round: round + 1,
              attempt: forcedDiagnosisAttempts + 1,
            });
            forcedDiagnosisAttempts++;
            messages.push({ role: 'assistant', content: responseContent });
            messages.push({ role: 'user', content: FORCED_DIAGNOSIS_SKELETON_PROMPT });
            round--;
            continue;
          }
          this.logger.warn('[SRE-DIAGNOSTICIAN] LLM ignored forced diagnosis (no tools used)', {
            round: round + 1,
            attempts: forcedDiagnosisAttempts,
          });
          break;
        }

        this.trace(
          isDryRun,
          'branch-tool-calls',
          {
            round: round + 1,
            toolCount: toolCalls.length,
            tools: toolCalls.map(c => c.tool),
          },
          payload.fingerprint
        );

        // If we already forced diagnosis and LLM still emitted tool calls, retry or give up
        if (forcedDiagnosisAttempts > 0) {
          if (forcedDiagnosisAttempts >= MAX_FORCED_DIAGNOSIS_ATTEMPTS) {
            this.trace(
              isDryRun,
              'branch-taken',
              { round: round + 1, branch: 'forced-diagnosis-escalation-exhausted' },
              payload.fingerprint
            );
            this.logger.warn('[SRE-DIAGNOSTICIAN] LLM ignored forced diagnosis instruction', {
              round: round + 1,
              attempts: forcedDiagnosisAttempts,
            });
            break;
          }
          // Escalate: provide JSON skeleton directly
          this.logger.warn('[SRE-DIAGNOSTICIAN] LLM ignored forced diagnosis, escalating with JSON skeleton', {
            round: round + 1,
            attempt: forcedDiagnosisAttempts + 1,
          });
          messages.push({ role: 'assistant', content: responseContent });
          messages.push({ role: 'user', content: FORCED_DIAGNOSIS_SKELETON_PROMPT });
          forcedDiagnosisAttempts++;
          // Don't count forced-diagnosis retries against MAX_TOOL_ROUNDS (hard cap: MAX_TOTAL_LLM_CALLS)
          round--;
          continue;
        }

        // Execute tool calls and build follow-up.
        // Sanitize the assistant message: strip fabricated text after the last tool block
        // to prevent the LLM from seeing its own fabricated "Tool Result:" or diagnosis output.
        const sanitizedContent = this.sanitizeToolResponse(responseContent);
        messages.push({ role: 'assistant', content: sanitizedContent });

        const toolResults: string[] = [];
        let budgetExhausted = false;

        for (const call of toolCalls) {
          // Check budget BEFORE executing - no wasted calls
          if (toolContext.apiCallCounter.count >= toolContext.apiCallCounter.max) {
            budgetExhausted = true;
            this.logger.warn('[SRE-DIAGNOSTICIAN] Tool call budget exhausted mid-batch', {
              round: round + 1,
              used: toolContext.apiCallCounter.count,
              max: toolContext.apiCallCounter.max,
              skippedTools: toolCalls.slice(toolCalls.indexOf(call)).map(c => c.tool),
            });
            break;
          }

          this.logger.info('[SRE-DIAGNOSTICIAN] Executing tool', { tool: call.tool, input: call.input });

          const output = await executeTool(call.tool, call.input, toolContext);
          const isRateLimited = output.startsWith(RATE_LIMITED_SENTINEL);
          const isError =
            output.startsWith('Error:') ||
            output.startsWith('File not found:') ||
            output.startsWith('No files found at:') ||
            output.startsWith('Unknown tool:');
          // Rate-limited calls provide no useful data - exclude from toolCallLog
          // but include in toolResults so the LLM can switch strategies
          if (!isRateLimited) {
            toolCallLog.push({ tool: call.tool, input: call.input, output });
            if (!isError) successfulToolCalls++;
          }
          toolResults.push(`## Tool Result: ${call.tool}\nInput: ${JSON.stringify(call.input)}\n\n${output}`);

          this.trace(
            isDryRun,
            'tool-execute',
            {
              round: round + 1,
              tool: call.tool,
              input: call.input,
              outputLength: output.length,
              outputPreview: output.slice(0, 500),
            },
            payload.fingerprint
          );

          // Check again after execution (this call may have been the one that hit the limit)
          if (toolContext.apiCallCounter.count >= toolContext.apiCallCounter.max) {
            budgetExhausted = true;
            this.logger.warn('[SRE-DIAGNOSTICIAN] Tool call budget exhausted', {
              round: round + 1,
              used: toolContext.apiCallCounter.count,
              max: toolContext.apiCallCounter.max,
            });
          }
        }

        // Hard cap: budget enforcement should never allow more executions than the budget.
        // If this fires, it means the per-call budget check above has a bug.
        // Fall through to forced-diagnosis logic instead of breaking - the LLM may
        // still produce a useful diagnosis from the data it already gathered.
        if (toolCallLog.length > toolContext.apiCallCounter.max) {
          this.logger.error('[SRE-DIAGNOSTICIAN] Hard cap exceeded — possible budget enforcement bug', {
            toolCallCount: toolCallLog.length,
            budget: toolContext.apiCallCounter.max,
            round: round + 1,
          });
          budgetExhausted = true;
        }

        // Mid-loop course correction: if multiple tools failed this round, nudge the LLM
        const errorCount = toolResults.filter(
          r => r.includes('File not found:') || r.includes('No files found at:') || r.includes('Error:')
        ).length;
        if (errorCount >= 3) {
          toolResults.push(
            '\n⚠️ Multiple tool calls failed this round. Use github_code_search with keywords from the error message to locate relevant files. Do not guess file paths.'
          );
        }

        // Add tool results as a user message (no budget info - LLM investigates freely)
        messages.push({
          role: 'user',
          content: toolResults.join('\n\n---\n\n'),
        });

        // Structured budget logging for operators (CloudWatch), not the LLM
        this.logger.info('[SRE-DIAGNOSTICIAN] Budget status after round', {
          round: round + 1,
          used: toolContext.apiCallCounter.count,
          max: toolContext.apiCallCounter.max,
          remaining: toolContext.apiCallCounter.max - toolContext.apiCallCounter.count,
        });

        this.trace(
          isDryRun,
          'budget-state',
          {
            round: round + 1,
            used: toolContext.apiCallCounter.count,
            max: toolContext.apiCallCounter.max,
            remaining: toolContext.apiCallCounter.max - toolContext.apiCallCounter.count,
            budgetExhausted,
          },
          payload.fingerprint
        );

        // Force diagnosis when budget is exhausted OR on the last normal round -
        // without this, a high-budget LLM can use tools across all rounds and exit
        // the loop without ever being asked to produce a diagnosis.
        const lastRound = round >= MAX_TOOL_ROUNDS - 1;
        if (budgetExhausted || lastRound) {
          this.trace(
            isDryRun,
            'forced-diagnosis-injected',
            {
              round: round + 1,
              reason: budgetExhausted ? 'budget-exhausted' : 'last-round',
              forcedDiagnosisAttempts: forcedDiagnosisAttempts + 1,
            },
            payload.fingerprint
          );
          forcedDiagnosisAttempts++;
          messages.push({ role: 'user', content: FORCED_DIAGNOSIS_PROMPT });
          // Ensure at least one more LLM call to read the forced-diagnosis prompt.
          // Without this, the loop exits before the LLM can respond to the prompt.
          if (lastRound) {
            round--;
          }
        }
      }

      this.trace(
        isDryRun,
        'loop-exit',
        {
          totalLlmCalls,
          forcedDiagnosisAttempts,
          toolCallCount: toolCallLog.length,
          finalMessageCount: messages.length,
        },
        payload.fingerprint
      );

      this.logger.warn('[SRE-DIAGNOSTICIAN] Max tool rounds exhausted without diagnosis', {
        totalLlmCalls,
        forcedDiagnosisAttempts,
      });

      // Emergency fallback for the forced-diagnosis exhaustion path: the loop
      // exited without ever producing a parseable diagnosis (LLM kept emitting
      // tool blocks instead of JSON). Uses a minimal system prompt with NO tool
      // descriptions to break tool-use conditioning. A second call site higher up
      // in this function (after retry-fail) covers the case where the LLM produced
      // a diagnosis that consistently failed Zod.
      if (forcedDiagnosisAttempts >= MAX_FORCED_DIAGNOSIS_ATTEMPTS && totalLlmCalls < MAX_TOTAL_LLM_CALLS) {
        totalLlmCalls++;
        this.logger.warn('[SRE-DIAGNOSTICIAN] Attempting emergency context-reset diagnosis', {
          totalLlmCalls,
          toolCallLogEntries: toolCallLog.length,
        });
        const emergencyResult = await tryEmergencyDiagnosis();
        if (emergencyResult) {
          return withTrace({
            diagnosis: { ...emergencyResult.diagnosis, toolCalls: toolCallLog },
            truncationRepaired: emergencyResult.truncationRepaired,
          });
        }
      }

      return withTrace({
        diagnosis: null,
        failureReason:
          forcedDiagnosisAttempts > 0
            ? `LLM ignored forced diagnosis instruction (${forcedDiagnosisAttempts} attempts, ${totalLlmCalls} LLM calls)`
            : `Max tool rounds exhausted without diagnosis (${totalLlmCalls} LLM calls)`,
      });
    } catch (error) {
      this.logger.error('[SRE-DIAGNOSTICIAN] Diagnosis failed', { error });
      return withTrace({
        diagnosis: null,
        failureReason: `Unhandled error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Revise an existing diagnosis based on reviewer feedback.
   * Delegates to diagnose() with revision context - same tool-use loop, validation, and safety checks.
   * Skips pattern library (always needs fresh LLM analysis) and checks for identical diffs.
   */
  async revise(
    payload: SreEventPayload,
    config: ResolvedRepoConfig,
    apiKeyTable: ApiKeyTable,
    toolContext: SreToolContext,
    originalDiagnosis: SreDiagnosis,
    reviewFeedback: string,
    ciFailureOutput?: string
  ): Promise<DiagnoseResult> {
    this.logger.info('[SRE-DIAGNOSTICIAN] Starting revision', {
      fingerprint: payload.fingerprint,
      originalConfidence: originalDiagnosis.confidence,
      reviewFeedbackLength: reviewFeedback.length,
      hasCiFailureOutput: !!ciFailureOutput,
    });

    return this.diagnose(payload, config, apiKeyTable, toolContext, undefined, false, undefined, {
      originalDiagnosis,
      reviewFeedback,
      ciFailureOutput,
    });
  }

  /**
   * Sanitize an LLM response that contains tool call blocks.
   * Strips everything after the last ```tool...``` block to remove
   * fabricated "Tool Result:" text and premature diagnosis blocks.
   * Returns the original text if no tool blocks are found.
   */
  sanitizeToolResponse(text: string): string {
    // Find the end of the last ```tool...``` block using lastIndexOf (no regex backtracking risk)
    const closingFence = '```';
    const toolBlockMarker = '```tool';

    // Find the last tool block opening
    const lastToolStart = text.lastIndexOf(toolBlockMarker);
    if (lastToolStart === -1) return text;

    // Find the closing fence after the last tool block opening
    const afterToolStart = lastToolStart + toolBlockMarker.length;
    const closingIndex = text.indexOf(closingFence, afterToolStart);
    if (closingIndex === -1) return text; // unclosed block — return as-is

    const endOfLastToolBlock = closingIndex + closingFence.length;

    // If there's significant content after the last tool block, strip it
    const trailing = text.slice(endOfLastToolBlock).trim();
    if (trailing.length === 0) return text;

    return text.slice(0, endOfLastToolBlock);
  }

  /**
   * Parse tool call blocks from LLM response text.
   * Expected format: ```tool\n{"tool": "name", "input": {...}}\n```
   */
  private parseToolCalls(text: string): Array<{ tool: string; input: Record<string, unknown> }> {
    const toolCalls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    const toolBlockRegex = /```tool\s*([\s\S]*?)```/g;
    let match;

    while ((match = toolBlockRegex.exec(text)) !== null) {
      if (toolCalls.length >= MAX_TOOL_CALLS_PER_RESPONSE) {
        this.logger.warn('[SRE-DIAGNOSTICIAN] Truncating excessive tool calls from single response', {
          maxAllowed: MAX_TOOL_CALLS_PER_RESPONSE,
        });
        break;
      }
      try {
        const parsed = JSON.parse(sanitizeJsonStringWithMeta(match[1].trim()).result);
        if (parsed.tool && typeof parsed.tool === 'string') {
          if (
            parsed.input &&
            typeof parsed.input === 'object' &&
            !Array.isArray(parsed.input) &&
            Object.keys(parsed.input).length > 0
          ) {
            toolCalls.push({ tool: parsed.tool, input: parsed.input });
          } else {
            this.logger.warn('[SRE-DIAGNOSTICIAN] Skipping tool call with missing/empty input', {
              tool: parsed.tool,
              rawInput: parsed.input,
            });
          }
        }
      } catch {
        this.logger.warn('[SRE-DIAGNOSTICIAN] Failed to parse tool call block', {
          block: match[1].slice(0, 200),
        });
      }
    }

    return toolCalls;
  }

  /**
   * Parse, validate, and sanitize a diagnosis JSON string.
   * Returns { result, error } - error is populated on parse/validation failure
   * so callers can include it in retry prompts.
   */
  private async parseDiagnosis(
    jsonString: string,
    config: ResolvedRepoConfig,
    toolCallLog: Array<{ tool: string; input: Record<string, unknown>; output: string }>,
    toolContext: SreToolContext,
    options?: { skipTestFileCheck?: boolean; blockTestFiles?: boolean }
  ): Promise<{ result: SreDiagnosis | null; error?: string; truncationRepaired?: boolean }> {
    try {
      const {
        result: sanitized,
        repairedQuotes,
        truncationRepaired,
      } = sanitizeJsonStringWithMeta(jsonString.trim(), {
        attemptTruncationRepair: true,
      });
      if (repairedQuotes > 0) {
        this.logger.warn('[SRE-DIAGNOSTICIAN] Quote repair applied to diagnosis JSON', {
          repairedQuotes,
        });
      }
      if (truncationRepaired) {
        this.logger.warn('[SRE-DIAGNOSTICIAN] Truncation repair applied to diagnosis JSON');
      }
      const parsed = JSON.parse(sanitized);
      const validated = SreDiagnosisSchema.parse(parsed);

      // Cap LLM-reported confidence - model can claim 100% but we cap at 95
      // to ensure at least some human oversight in the gate logic
      validated.confidence = Math.min(validated.confidence, 95);

      // Validate file scope - collect ALL unique violations so callers can detect scope-blocked state.
      // Rule 2 (CI self-heal, options.blockTestFiles): test files are out of scope entirely - a fix that
      // can only go green by editing a test must escalate, not weaken the test. Reusing the scope-violation
      // error routes it through the existing re-prompt -> scope_blocked escalation machinery.
      const blockedFileSet = new Set<string>();
      for (const file of validated.affectedFiles) {
        const outOfScope = !this.isFileAllowed(file.filePath, config.allowedFilePatterns, config.blockedFilePatterns);
        const testBlocked = options?.blockTestFiles === true && isSreTestFile(file.filePath);
        if (outOfScope || testBlocked) {
          blockedFileSet.add(file.filePath);
        }
      }
      if (blockedFileSet.size > 0) {
        const blockedFiles = [...blockedFileSet];
        this.logger.warn('[SRE-DIAGNOSTICIAN] Files not in allowed scope', {
          blockedFiles,
          blockTestFiles: options?.blockTestFiles === true,
        });
        return { result: null, error: `Files not in allowed scope: ${blockedFiles.join(', ')}` };
      }

      // Rule 1 - tests follow code, never lead: an existing test assertion may only be updated
      // alongside the source change that justifies it. A diagnosis that only modifies existing
      // tests is the "edit the test to make it pass" signature and is always rejected. Creating
      // a brand-new test file (kind 'create') is exempt - it cannot weaken an existing guard and
      // pairing a regression test with a fix is supported.
      const allTestFiles =
        validated.affectedFiles.length > 0 && validated.affectedFiles.every(f => isSreTestFile(f.filePath));
      const modifiesExistingTest = validated.affectedFiles.some(
        f => isSreTestFile(f.filePath) && (f.kind ?? 'replace') !== 'create'
      );
      if (allTestFiles && modifiesExistingTest) {
        this.logger.warn('[SRE-DIAGNOSTICIAN] Test-only diagnosis rejected (tests follow code, never lead)', {
          files: validated.affectedFiles.map(f => f.filePath),
        });
        return {
          result: null,
          error:
            'Test-only change rejected: an existing test may only be modified alongside a non-test source change (tests follow code, never lead). Fix the source, or if the test encodes intended behavior your fix contradicts, set escalate:true with empty affectedFiles.',
        };
      }

      // Validate no dangerous patterns in proposed code
      for (const file of validated.affectedFiles) {
        for (const pattern of DANGEROUS_PATTERNS) {
          if (pattern.test(file.after)) {
            this.logger.warn('[SRE-DIAGNOSTICIAN] Dangerous pattern detected in proposed code', {
              filePath: file.filePath,
              pattern: pattern.source,
            });
            return { result: null, error: `Dangerous pattern detected in ${file.filePath}` };
          }
        }
      }

      // Validate total diff size
      const totalDiffLines = validated.affectedFiles.reduce((sum, f) => {
        const beforeLines = f.before.split('\n').length;
        const afterLines = f.after.split('\n').length;
        return sum + Math.max(beforeLines, afterLines);
      }, 0);

      // Validate insert hunk anchor preservation - "after" must start with "before" verbatim.
      // Delimiter balance checks were removed: naive bracket counting produces false positives
      // on real-world code containing brackets in strings, regex, comments, or template literals.
      // The before-block uniqueness check below is a stronger correctness guarantee.
      for (const file of validated.affectedFiles.filter(f => f.kind === 'insert')) {
        if (!file.after.startsWith(file.before)) {
          return {
            result: null,
            error: `Insert hunk for ${file.filePath}: "after" must start with "before" verbatim (anchor preservation). Got after[0..${file.before.length}] = ${JSON.stringify(file.after.slice(0, file.before.length))}, expected ${JSON.stringify(file.before)}.`,
          };
        }
      }

      // Duplicate-anchor guard: within a single file, no two hunks may share
      // the same `before`. String.prototype.replace is first-match-only, so
      // duplicate anchors would silently stack both edits at the first match.
      // 'create' hunks have no anchor; we instead reject duplicate filePaths
      // for 'create' (can't create the same file twice).
      const perFileBefores = new Map<string, Set<string>>();
      const createdPaths = new Set<string>();
      for (const file of validated.affectedFiles) {
        if (file.kind === 'create') {
          if (createdPaths.has(file.filePath)) {
            return {
              result: null,
              error: `Duplicate "create" hunk for ${file.filePath}. Each new file may be created at most once.`,
            };
          }
          createdPaths.add(file.filePath);
          continue;
        }
        const set = perFileBefores.get(file.filePath) ?? new Set<string>();
        if (set.has(file.before)) {
          return {
            result: null,
            error: `Duplicate "before" anchor in ${file.filePath}. Each hunk in the same file must use a distinct anchor.`,
          };
        }
        // Anchor-substring-overlap guard: if this hunk's `before` contains or is
        // contained by another hunk's `before` in the same file, sequential
        // String.replace calls consume overlapping text and the second hunk's
        // anchor no longer matches. Reject at validation time for a clear error
        // instead of letting the apply script fail late with "before not found".
        for (const existing of set) {
          if (file.before.includes(existing) || existing.includes(file.before)) {
            return {
              result: null,
              error: `Overlapping "before" anchors in ${file.filePath}: one hunk's anchor is a substring of another. Sequential text replacements would corrupt each other — tighten the anchors so they do not overlap.`,
            };
          }
        }
        set.add(file.before);
        perFileBefores.set(file.filePath, set);
      }

      // Validate before-block uniqueness against actual file contents.
      // 'create' hunks invert the check: the file MUST NOT exist (we cannot
      // create over an existing file).
      const uniquenessErrors: string[] = [];
      for (const file of validated.affectedFiles) {
        if (file.kind === 'create') {
          const existing = await toolContext.getFileContent(file.filePath);
          if (existing !== null) {
            uniquenessErrors.push(
              `${file.filePath}: "create" hunk target file already exists. Use "replace" or "insert" to modify an existing file.`
            );
          }
          continue;
        }
        if (file.before === file.after) {
          uniquenessErrors.push(`${file.filePath}: "before" and "after" are identical (no-op change)`);
          continue;
        }
        const content = await toolContext.getFileContent(file.filePath);
        if (content === null) {
          uniquenessErrors.push(`${file.filePath}: file not found or unreadable`);
          continue;
        }
        // Count occurrences using indexOf loop (efficient for large files)
        let count = 0;
        const matchLineNumbers: number[] = [];
        let pos = 0;
        while ((pos = content.indexOf(file.before, pos)) !== -1) {
          count++;
          const lineNum = content.substring(0, pos).split('\n').length;
          matchLineNumbers.push(lineNum);
          pos += file.before.length;
        }
        if (count === 0) {
          uniquenessErrors.push(
            `${file.filePath}: "before" block not found in file. The file may have changed since you read it, or there may be whitespace/line-ending differences.`
          );
        } else if (count > 1) {
          uniquenessErrors.push(
            `${file.filePath}: "before" block matches ${count} times at lines ${matchLineNumbers.join(', ')} (must be exactly 1). Include more surrounding context — the function name, preceding comment, or neighboring lines — to disambiguate. You do NOT need to re-read the file.`
          );
        }
      }
      if (uniquenessErrors.length > 0) {
        return {
          result: null,
          error: `Before-block uniqueness check failed:\n${uniquenessErrors.join('\n')}`,
        };
      }

      // Detect test files that were read but not included in affectedFiles.
      // Skip on retry - the LLM cannot un-read a file, so this check always fails identically.
      // Skip entirely in the CI self-heal path (Rule 2): tests are blocked there, so we must NOT
      // push the LLM to include a test file - that would contradict the source-only requirement.
      if (!options?.skipTestFileCheck && !options?.blockTestFiles) {
        const readTestFiles = [
          ...new Set(
            toolCallLog
              .filter(
                call =>
                  call.tool === 'github_file_read' && /\.(test|spec)\.[jt]sx?$/.test(String(call.input.path ?? ''))
              )
              .map(call => String(call.input.path))
          ),
        ];

        if (readTestFiles.length > 0 && validated.affectedFiles.length > 0) {
          const affectedDirs = new Set(validated.affectedFiles.map(f => f.filePath.replace(/\/[^/]+$/, '')));
          const affectedPaths = new Set(validated.affectedFiles.map(f => f.filePath));

          const isColocated = (testPath: string) => {
            const testDir = testPath.replace(/\/[^/]+$/, '');
            if (affectedDirs.has(testDir)) return true;
            // __tests__/foo.test.ts -> parent dir matches source dir
            if (testDir.endsWith('/__tests__') && affectedDirs.has(testDir.replace(/\/__tests__$/, ''))) return true;
            return false;
          };

          const missingTestFiles = readTestFiles.filter(
            testPath => !affectedPaths.has(testPath) && isColocated(testPath)
          );

          if (missingTestFiles.length > 0) {
            return {
              result: null,
              error: `You read test file(s) ${missingTestFiles.join(', ')} but did not include them in affectedFiles. If your fix changes strings, return values, or behavior that these tests assert on, you MUST include the test file with updated assertions. If no test update is needed, re-emit your diagnosis unchanged and explain in proposedFix why the test file does not need updating.`,
            };
          }
        }
      }

      if (totalDiffLines > config.maxDiffLines) {
        this.logger.warn('[SRE-DIAGNOSTICIAN] Diff too large', {
          totalDiffLines,
          maxDiffLines: config.maxDiffLines,
        });
        return { result: null, error: `Diff too large: ${totalDiffLines} lines (max ${config.maxDiffLines})` };
      }

      // Observability: track insert vs replace hunk usage so we can see
      // whether the prompt guidance is being followed over time.
      const hunkKinds = validated.affectedFiles.reduce<Record<string, number>>((acc, f) => {
        const kind = f.kind ?? 'replace';
        acc[kind] = (acc[kind] ?? 0) + 1;
        return acc;
      }, {});
      this.logger.info('[SRE-DIAGNOSTICIAN] Diagnosis validated', {
        hunkCount: validated.affectedFiles.length,
        hunkKinds,
      });

      // Warn when truncation repair was applied AND affectedFiles is non-empty -
      // string values in those hunks may be semantically truncated even though structurally valid.
      // parseDiagnosis safety checks (scope, dangerous patterns, before-block uniqueness) still apply.
      if (truncationRepaired && validated.affectedFiles.length > 0) {
        this.logger.warn(
          '[SRE-DIAGNOSTICIAN] Truncation-repaired diagnosis has non-empty affectedFiles — hunk strings may be incomplete',
          {
            hunkCount: validated.affectedFiles.length,
          }
        );
      }

      return {
        result: {
          ...validated,
          toolCalls: toolCallLog,
        },
        truncationRepaired,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error('[SRE-DIAGNOSTICIAN] Failed to parse diagnosis JSON', {
        error,
        jsonString: jsonString.slice(0, 500),
      });
      this.logger.warn('[SRE-DIAGNOSTICIAN] Raw JSON that failed parsing (post-sanitization)', {
        rawJson: sanitizeJsonString(jsonString.trim()).slice(0, 1000),
      });
      return { result: null, error: errorMsg };
    }
  }

  /**
   * Check whether a file path matches the allowed patterns and does not match blocked patterns.
   * Uses simple glob-like matching (supports * and ** wildcards).
   */
  private isFileAllowed(filePath: string, allowedPatterns: string[], blockedPatterns: string[]): boolean {
    const matchesPattern = (path: string, pattern: string): boolean => {
      // Convert glob pattern to regex
      const regexStr = pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '{{DOUBLESTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\{\{DOUBLESTAR\}\}/g, '.*');
      return new RegExp(`^${regexStr}$`).test(path);
    };

    // Check blocked first
    for (const pattern of blockedPatterns) {
      if (matchesPattern(filePath, pattern)) {
        return false;
      }
    }

    // Check allowed
    for (const pattern of allowedPatterns) {
      if (matchesPattern(filePath, pattern)) {
        return true;
      }
    }

    return false;
  }
}
