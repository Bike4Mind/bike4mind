import { BadRequestError, InternalServerError } from '@bike4mind/utils';
import { getAvailableModels, getLlmByModel, type ApiKeyTable } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';
import { ChatModels } from '@bike4mind/common';

const SingleLakeFactSchema = z.object({
  /** The durable, standalone fact, stated plainly. */
  fact: z.string(),
  /** 1-10: how central this fact is to the document's subject; used to cap per-doc extraction. */
  importance: z.number().min(1).max(10),
});

const LakeFactResponseSchema = z.object({
  /** Absent/empty when the document carries no durable, citable facts (boilerplate, nav, an index). */
  facts: z.array(SingleLakeFactSchema).optional(),
});

export type LakeFact = z.infer<typeof SingleLakeFactSchema>;

/** At most this many facts per document, keeping the highest-importance ones - mirrors the memento cap. */
export const LAKE_FACTS_PER_DOC_MAX = 12;

/**
 * The lake-fact extraction guidance - the single highest-leverage piece of text in the lake memory
 * system, and (per Erik) ultimately a MEASUREMENT call: tune it against the eval harness, not by taste.
 *
 * The target is fundamentally different from a personal memento. A memento is a fact about the PERSON;
 * a lake fact is a durable, CITABLE claim about the lake's subject matter - the kind of reference fact
 * that grounds an answer and points back at a source document. So the guidance steers away from
 * personal-info framing and toward standalone, verifiable statements, while keeping the memento
 * pipeline's hard-won "write the fact, do not narrate" discipline (a fact narrated as "the document
 * discusses X" retrieves as well but reads as a transcript once injected under a KNOWLEDGE heading).
 */
const LAKE_FACT_GUIDANCE = `
      HOW TO WRITE EACH FACT - this is the part that decides whether the memory is any good:

      Write the FACT itself, as a durable standalone statement about the SUBJECT. It gets injected into a
      future prompt as trusted background knowledge and must still read as a fact with no document around
      it, so anything that describes the document rather than the subject is noise.

      NEVER write:
        - "The document describes/covers/discusses/mentions ..."   <- narration about the doc, not a fact
        - "This section explains that ..."                         <- structure, not content
        - "It is suggested/implied that ..."                       <- hedging. State it or drop it.
      ALWAYS write the bare, self-contained fact:
        BAD : "The document explains that the X-200 pump has a 5-year warranty."
        GOOD: "The X-200 pump has a 5-year warranty."
        BAD : "This page lists the supported file formats."
        GOOD: (nothing - a list-of-contents is not a durable fact. Omit it.)

      Keep every specific - names, numbers, dates, models, thresholds. Those ARE the value.
      Keep a fact whole; do not shred one claim into fragments, and do not merge unrelated claims.
      Extract only what a reader would want to CITE later: durable facts about the subject, not the
      document's boilerplate, navigation, disclaimers, or the author's opinions.
`;

/**
 * The lake-fact extraction prompt. `docTitle` anchors the facts (a doc's title often carries the
 * subject the body only refers to as "it"); `docText` is the document's extractable text.
 */
export const buildLakeFactExtractionPrompt = (docTitle: string, docText: string): string => `
      You are a knowledge extractor for a curated reference library. Your task is to identify the
      distinct, durable, CITABLE facts in a single reference document - the standalone claims that would
      help answer a future question about this subject and could be traced back to this document.

      Only extract statements that are:
      - FACTUAL claims about the subject (properties, definitions, procedures, numbers, relationships),
      - DURABLE (still true and useful outside the surrounding text), and
      - SELF-CONTAINED (understandable without the rest of the document).

      DO NOT extract:
      - Navigation, tables of contents, headings, boilerplate, legal disclaimers.
      - The author's opinions, marketing language, or hedged speculation.
      - Anything that only describes the document itself rather than its subject.

      For EACH fact, rate importance 1-10 by how central it is to the document's subject:
      - 9-10: the defining facts a reader must know about this subject
      - 6-8: substantive supporting facts (specs, procedures, key relationships)
      - 3-5: minor but still citable details
      - 1-2: trivia
${LAKE_FACT_GUIDANCE}
      LIMIT: return at most ${LAKE_FACTS_PER_DOC_MAX} facts, the most important ones.

      Document title: ${docTitle}

      Document text:
      ${docText}

      Respond in JSON format:
      {
        "facts": [
          { "fact": "The self-contained fact, stated plainly - NOT a description of the document", "importance": 1-10 }
        ]
      }

      If the document carries no durable, citable facts (it is an index, a nav page, pure boilerplate),
      return { "facts": [] }.
    `;

/**
 * Extract durable, citable facts from ONE lake reference document (#1440 producer). Mirrors
 * `MementoEvaluationService` structurally - resolve the model, stream a JSON-only completion, parse and
 * validate - but targets reference knowledge rather than personal mementos. Returns the facts, capped
 * and highest-importance-first, or null when the document yields none (or extraction fails - fail-soft,
 * a doc that will not extract simply contributes no beliefs).
 */
export class LakeMemoryExtractionService {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async evaluate({
    apiKeyTable,
    model = ChatModels.GPT4_1_MINI,
    docTitle,
    docText,
    endUserId,
  }: {
    apiKeyTable: ApiKeyTable;
    model?: ChatModels;
    docTitle: string;
    docText: string;
    /** Lake owner, for provider abuse attribution. */
    endUserId?: string;
  }): Promise<LakeFact[] | null> {
    if (!docText.trim()) return null;

    let responseContent = '';
    try {
      const modelInfo = (await getAvailableModels(apiKeyTable)).find(m => m.id === model);
      if (!modelInfo) throw new BadRequestError(`Invalid model: "${model}" is not available`);

      const llm = getLlmByModel(apiKeyTable, { modelInfo, logger: this.logger, endUserId });
      if (!llm) throw new InternalServerError(`Failed to initialize LLM for model: "${model}"`);

      await llm.complete(
        model,
        [{ role: 'user', content: buildLakeFactExtractionPrompt(docTitle, docText) }],
        // Low temperature: extraction, not generation - we want the document's facts, not creativity.
        { temperature: 0.2, maxTokens: 1200 },
        async texts => {
          responseContent += texts.join('');
        }
      );

      const validJsonStringOnly = responseContent.match(/\{[\s\S]*\}/)?.[0];
      const parsed = LakeFactResponseSchema.parse(JSON.parse(validJsonStringOnly || '{}'));

      if (!parsed.facts || parsed.facts.length === 0) {
        this.logger.info('Lake extraction found no durable facts in document, skipping', { docTitle });
        return null;
      }

      // Cap to the most important, so a huge document cannot flood one lake's profile.
      const facts = [...parsed.facts].sort((a, b) => b.importance - a.importance).slice(0, LAKE_FACTS_PER_DOC_MAX);
      this.logger.info('Extracted lake facts from document', { docTitle, count: facts.length });
      return facts;
    } catch (error) {
      this.logger.updateMetadata({ responseContent });
      this.logger.warn('Failed to extract lake facts from document:', error);
      return null;
    }
  }
}
