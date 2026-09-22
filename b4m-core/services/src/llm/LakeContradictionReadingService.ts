import { BadRequestError, InternalServerError } from '@bike4mind/utils';
import { getAvailableModels, getLlmByModel, type ApiKeyTable } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';
import { ChatModels, EXCERPT_MAX, excerpt } from '@bike4mind/common';
import { createSmallLLMService } from './SmallLLMService';

const ContradictionSourceSchema = z.object({
  /** Must be one of the ids the batch actually supplied - the caller filters out anything else. */
  fabFileId: z.string(),
  /** The passage that states this document's side of the disagreement. */
  excerpt: z.string(),
});

const ModelContradictionSchema = z.object({
  /**
   * A short, stable noun phrase naming what the documents disagree about (e.g. "refund window",
   * "who owns onboarding") - never a full sentence. Stability matters: this becomes the finding's
   * `subject`, part of the `(lakeId, detector, kind, subject)` key `recordLakeFindings` upserts on,
   * so a model that phrases the same disagreement differently on every run mints a new row every
   * run instead of updating one. Asking for a terse, literal label is a mitigation, not a
   * guarantee - an LLM's phrasing is inherently less stable than a regex's fixed vocabulary, and
   * that is an honest property of a model-driven pass rather than a bug in this prompt.
   */
  subject: z.string(),
  /** At least two documents genuinely in tension - one is not a contradiction. */
  documents: z.array(ContradictionSourceSchema).min(2),
});

const ModelContradictionResponseSchema = z.object({
  contradictions: z.array(ModelContradictionSchema).optional(),
});

export type ModelContradiction = z.infer<typeof ModelContradictionSchema>;

export interface ContradictionCandidateDocument {
  fabFileId: string;
  fileName: string | null;
  /** Already bounded by the caller (`MODEL_INCONSISTENCY_DOC_CHARS`) before it reaches this class. */
  text: string;
}

/**
 * The contradiction-reading prompt. Deliberately scoped AWAY from the four lexical shapes
 * (superlative, metric, relationship, expired-claim) - a cheap pattern already catches those, so
 * asking the model to also chase them just spends its budget re-finding what `corpusInconsistency.ts`
 * finds for free. This exists for the shape neither than pass nor #2242's original scope covers:
 * ordinary prose where two documents flatly disagree.
 */
function buildContradictionPrompt(documents: ContradictionCandidateDocument[]): string {
  const docBlocks = documents
    .map(
      (doc, i) => `
[document ${i + 1} id="${doc.fabFileId}" name="${doc.fileName ?? doc.fabFileId}"]
${doc.text}
[/document ${i + 1}]`
    )
    .join('\n');

  return `
      You are reviewing a set of reference documents from the same curated knowledge base for
      CONTRADICTIONS - places where two or more documents state genuinely INCOMPATIBLE things about
      the same subject in ordinary prose.

      You are the second pass over this corpus. A cheap pattern matcher already catches four narrow
      shapes and you do NOT need to re-report them: two documents each claiming sole "#1"/"only"/
      "fastest" status in the same category; the same labelled metric given two different values;
      an organization called a customer in one document and a prospect in another; a claim whose
      stated year has already passed. Your job is everything a pattern cannot see: contradictions
      that only show up when you actually READ the prose - conflicting policies, incompatible
      procedures, mutually exclusive claims about the same entity or event, and any other flat
      disagreement in ordinary language.

      Report ONLY genuine, confident contradictions - two documents that CANNOT both be true at once.
      Do not report:
      - Two documents that are merely about different things, or emphasize different aspects of the
        same thing without actually conflicting.
      - A document disagreeing with itself (that is not what this is for).
      - Vague tonal or stylistic differences.
      A weak or speculative "contradiction" costs the human reviewing it more than it saves; when in
      doubt, leave it out.

      For each real contradiction you find, cite the EXACT documents involved by the id given below
      and quote the specific passage from EACH that shows its side of the disagreement - do not
      paraphrase the quote, and keep each quote under ${EXCERPT_MAX} characters.

      Documents (${documents.length} total):
      ${docBlocks}

      Respond in JSON format:
      {
        "contradictions": [
          {
            "subject": "a short, stable noun phrase naming what they disagree about - 2-6 words, not a sentence",
            "documents": [
              { "fabFileId": "<the exact id from above>", "excerpt": "<the quoted passage, verbatim>" }
            ]
          }
        ]
      }

      If you find no genuine contradictions, return { "contradictions": [] }.
    `;
}

/**
 * Read a batch of lake documents and surface the contradictions between them that no pattern rule
 * can see (#3057) - the reading half of the corpus-inconsistency detector, alongside the pure,
 * LLM-free lexical rules in `corpusInconsistency.ts`.
 *
 * DETECTION ONLY, same guardrail as the rest of this cluster (#2242): a returned contradiction is a
 * finding for a human to judge, never an instruction to reject, edit or remove anything.
 *
 * Fail-soft, mirroring `LakeMemoryExtractionService`: a batch that cannot be read or parsed
 * contributes no findings rather than failing the whole run. The caller (`detectLakeInconsistenciesModel`)
 * is what turns a null here into a counted, isolated batch failure.
 */
export class LakeContradictionReadingService {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async evaluate({
    apiKeyTable,
    model = ChatModels.GPT4_1_MINI,
    documents,
    endUserId,
  }: {
    apiKeyTable: ApiKeyTable;
    model?: ChatModels;
    documents: ContradictionCandidateDocument[];
    /** Lake owner, for provider abuse attribution - matches `LakeMemoryExtractionService`. */
    endUserId?: string;
  }): Promise<ModelContradiction[] | null> {
    // Nothing to compare. Below 2 the request would still bill for a read that can only ever answer
    // "no contradictions" - cheaper to refuse it here than to ask the model.
    if (documents.length < 2) return [];

    try {
      const modelInfo = (await getAvailableModels(apiKeyTable)).find(m => m.id === model);
      if (!modelInfo) throw new BadRequestError(`Invalid model: "${model}" is not available`);

      const llm = getLlmByModel(apiKeyTable, { modelInfo, logger: this.logger, endUserId });
      if (!llm) throw new InternalServerError(`Failed to initialize LLM for model: "${model}"`);

      const smallLLM = createSmallLLMService({ llm, modelId: model }, this.logger);
      const { data } = await smallLLM.completeJSON(
        buildContradictionPrompt(documents),
        ModelContradictionResponseSchema,
        {
          taskType: 'extraction',
          temperature: 0,
          // Generous relative to LakeMemoryExtractionService's single-doc 1200: this reads and compares
          // several documents at once and may cite quotes from each across several contradictions.
          maxTokens: 3000,
          retries: 1,
        }
      );

      // Guard against a hallucinated id: the model must cite documents it was actually given, not
      // invent one. A contradiction that loses a source to this filter is no longer cross-document.
      const knownIds = new Set(documents.map(d => d.fabFileId));
      const grounded = (data.contradictions ?? [])
        .map(c => ({ ...c, documents: c.documents.filter(d => knownIds.has(d.fabFileId)) }))
        .filter(c => c.documents.length >= 2)
        .map(c => ({ ...c, documents: c.documents.map(d => ({ ...d, excerpt: excerpt(d.excerpt) })) }));

      this.logger.info('Model contradiction pass evaluated a batch', {
        documentCount: documents.length,
        contradictionsFound: grounded.length,
      });
      return grounded;
    } catch (error) {
      this.logger.warn('Model contradiction pass failed for batch:', error);
      return null;
    }
  }
}
