import { getLlmByModel } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';
import { IChatHistoryItemDocument, PromptIntent } from '@bike4mind/common';
import { getEffectiveApiKeyByBackend, OperationsModelService } from '@client/services/operationsModelService';
import { serializeError } from './serializeError';

export const HISTORY_LOOKBACK = 6;
const REPLY_TRUNCATE_CHARS = 250;
const RESOLVER_TIMEOUT_MS = 5000;

export type PromptResolution = {
  rewrittenPrompt: string;
  intent: PromptIntent;
};

const PromptResolutionSchema = z.object({
  rewrittenPrompt: z.string().min(1),
  intent: z.enum(['fresh', 'continuation']),
});

const RESOLVER_SYSTEM_PROMPT = `You are a prompt resolver for image generation in a multi-turn conversation.

You will be given:
- An optional session summary covering long-term context (everything earlier in the conversation).
- The most recent turns of the conversation (oldest first), each tagged with the assistant's reply or "image generated".
- The user's latest message.

Your job:
1. Classify the user's intent:
   - "continuation": the user's latest message depends on prior context. This includes refining or varying a previously generated image, AND grounding a new image in subjects, brand details, style preferences, or decisions established earlier in the conversation.
   - "fresh": the user's latest message describes a self-contained subject unrelated to the prior context.
2. Rewrite the user's request into a single complete sentence that fully describes what they want, suitable for direct submission to an image model. Resolve pronouns and vague phrases against the session. Pull relevant details from the summary or recent turns when they help — brand names, established style, prior subject, agreed direction.

Rules:
- Output ONLY a single JSON object: {"intent": "continuation" | "fresh", "rewrittenPrompt": "<one complete sentence>"}.
- For "continuation", weave the relevant context into the rewritten prompt so the image model can succeed without seeing the prior turns.
- For "fresh", produce a self-contained prompt for the new subject; do not bleed prior-turn details into it.
- Never include prose, commentary, markdown, or surrounding text — JSON only.

Examples:

[Visual continuation — refining a prior image]
Recent turns:
  [1] user: "design a modern signage for a family compound" → image generated
User: "different variant, no lighting"
Output: {"intent":"continuation","rewrittenPrompt":"A modern signage design for the family compound gate, alternative variant without dramatic lighting."}

[Text-grounded — new image after extended discussion]
Session summary: User has been brainstorming a sustainable coffee brand called "Verdant". Established direction: minimalist wordmark, deep navy ink on cream, restrained humanist serif typography, evoking quiet artisanal craftsmanship.
Recent turns:
  [1] user: "let's lean humanist serif then" → assistant: "Good choice — pair it with generous letter-spacing for an artisanal feel."
User: "great, now generate the logo"
Output: {"intent":"continuation","rewrittenPrompt":"A minimalist wordmark logo for 'Verdant' sustainable coffee brand, set in a humanist serif with generous letter-spacing, deep navy ink on a cream background, evoking quiet artisanal craftsmanship."}

[Fresh subject mid-session]
Recent turns:
  [1] user: "design a signage for a family compound" → image generated
  [2] user: "different variant" → image generated
User: "now generate a stock photo of a sunset beach"
Output: {"intent":"fresh","rewrittenPrompt":"A stock photo of a sunset beach."}`;

const truncateReply = (s: string): string =>
  s.length <= REPLY_TRUNCATE_CHARS ? s : s.slice(0, REPLY_TRUNCATE_CHARS - 1).trimEnd() + '…';

const collapseWhitespace = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Best-effort extraction of an assistant reply from a quest document, regardless of where it lives. */
const extractReply = (msg: IChatHistoryItemDocument): string => {
  if (typeof msg.reply === 'string' && msg.reply.trim()) return collapseWhitespace(msg.reply);
  if (Array.isArray(msg.replies) && msg.replies.length > 0) {
    const joined = msg.replies
      .map(r => (typeof r === 'string' ? r : ((r as { content?: string })?.content ?? '')))
      .filter(Boolean)
      .join('');
    if (joined.trim()) return collapseWhitespace(joined);
  }
  return '';
};

/** Returns true if the session has any prior turn at all (text or image). The resolver runs only when this is true. */
export const sessionHasHistory = (recentMessages: IChatHistoryItemDocument[]): boolean => recentMessages.length > 0;

/**
 * Compact, oldest-first transcript for the resolver. Each prior turn becomes one line:
 *   [N] user: "<prompt>" -> image generated   (for image-gen turns)
 *   [N] user: "<prompt>" -> assistant: "<reply truncated to 250 chars>"   (for text turns)
 *   [N] user: "<prompt>" -> error             (for error turns)
 */
export const buildHistoryTranscript = (recentMessages: IChatHistoryItemDocument[]): string => {
  const oldestFirst = [...recentMessages].reverse();
  return oldestFirst
    .map((msg, i) => {
      const promptText = collapseWhitespace(msg.prompt ?? '');
      const idx = i + 1;
      if (msg.type === 'error') {
        return `[${idx}] user: "${promptText}" → error`;
      }
      if (Array.isArray(msg.images) && msg.images.length > 0) {
        return `[${idx}] user: "${promptText}" → image generated`;
      }
      const reply = extractReply(msg);
      if (reply) {
        return `[${idx}] user: "${promptText}" → assistant: "${truncateReply(reply)}"`;
      }
      return `[${idx}] user: "${promptText}" → reply`;
    })
    .join('\n');
};

/** Strip ```json fences and surrounding prose, then parse the first JSON object found. */
export const tryParseJsonObject = (raw: string): unknown => {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
};

/**
 * Resolve a follow-up image prompt against session history.
 *
 * Behavior:
 * - Literal first message of a session (no prior turns at all): skips the LLM call entirely, passes
 *   prompt through as `fresh`.
 * - Any prior history (text turns, image turns, or both): runs the operations model with structured-JSON
 *   output to classify intent (`fresh` vs `continuation`) and rewrite the prompt to be self-contained.
 *   The session summary, if present, is included as long-term context - it's pre-computed by the chat
 *   path's `SummarizeNotebookFeature` and stored on the Session doc, so consuming it adds zero extra
 *   cost.
 * - Any error or malformed output falls back to a safe default that preserves the original prompt and
 *   biases toward `continuation` (since the next-step pipeline gates image carryforward on this and
 *   silently dropping context is the bug we are fixing).
 *
 * Note: `intent === 'continuation'` covers BOTH visual continuation (refining a prior image) AND
 * text-grounded continuation (a new image informed by the conversation). The downstream image
 * dispatch only carries forward a prior image when `intent === 'continuation'` AND the model accepts
 * image input AND a prior image actually exists in the session - the text-grounded case naturally
 * skips the carryforward and relies on the rewritten prompt alone.
 */
export const resolveImagePrompt = async (args: {
  originalPrompt: string;
  recentMessages: IChatHistoryItemDocument[];
  sessionSummary?: string | null;
  logger: Logger;
  /** End user the image request is on behalf of, for provider abuse attribution. */
  endUserId?: string;
}): Promise<PromptResolution> => {
  const { originalPrompt, recentMessages, sessionSummary, logger, endUserId } = args;

  if (!sessionHasHistory(recentMessages)) {
    return { rewrittenPrompt: originalPrompt, intent: 'fresh' };
  }

  const fallback: PromptResolution = { rewrittenPrompt: originalPrompt, intent: 'continuation' };

  try {
    const operationsModel = await OperationsModelService.getOperationsModel();
    const operationsModelInfo = operationsModel.modelInfo;
    // Intent classification is a platform operation billed to the system key so quota stays
    // consistent with other operations callers (summarization, auto-naming). Provider abuse
    // attribution is separate from billing: the prompt content is user-authored, so the request
    // still carries the end-user identifier.
    const apiKey = await getEffectiveApiKeyByBackend('system', operationsModelInfo.backend);
    const apiKeyTable = { [operationsModelInfo.backend]: apiKey };
    const llmBackend = getLlmByModel(apiKeyTable, { modelInfo: operationsModelInfo, logger, endUserId });

    if (!llmBackend) {
      logger.warn('[resolveImagePrompt] No LLM backend for operations model; using fallback resolution', {
        backend: operationsModelInfo.backend,
        model: operationsModelInfo.id,
      });
      return fallback;
    }

    const transcript = buildHistoryTranscript(recentMessages.slice(0, HISTORY_LOOKBACK));
    const summarySection = sessionSummary?.trim() ? `Session summary:\n${sessionSummary.trim()}\n\n` : '';
    const userMessage = `${summarySection}Recent turns (oldest first):\n${transcript}\n\nUser's latest message: "${originalPrompt}"\n\nReturn JSON only.`;

    let raw = '';
    // Wrap the LLM call in a timeout race so resolver degradation can't silently consume Lambda
    // time. Under normal conditions gpt-4o-mini responds in 1-3s; the 5s budget is generous enough
    // to absorb tail latency while still failing fast into the safe fallback during API outages.
    await Promise.race([
      llmBackend.complete(
        operationsModelInfo.id,
        [
          { role: 'system' as const, content: RESOLVER_SYSTEM_PROMPT },
          { role: 'user' as const, content: userMessage },
        ],
        { temperature: 0.2, maxTokens: 500, stream: false },
        async (textParts: (string | null | undefined)[]) => {
          raw += textParts.filter(Boolean).join('');
        }
      ),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Resolver LLM call exceeded ${RESOLVER_TIMEOUT_MS}ms timeout`)),
          RESOLVER_TIMEOUT_MS
        )
      ),
    ]);

    const parsed = tryParseJsonObject(raw);
    const validated = PromptResolutionSchema.safeParse(parsed);

    if (!validated.success) {
      logger.warn('[resolveImagePrompt] Resolver returned malformed JSON; using fallback', {
        rawPreview: raw.slice(0, 200),
        zodError: validated.error.issues,
      });
      return fallback;
    }

    logger.log('[resolveImagePrompt] Resolved prompt against session history', {
      intent: validated.data.intent,
      hasSummary: !!sessionSummary?.trim(),
      historyTurns: Math.min(recentMessages.length, HISTORY_LOOKBACK),
      originalPreview: originalPrompt.slice(0, 80),
      rewrittenPreview: validated.data.rewrittenPrompt.slice(0, 80),
    });

    return validated.data;
  } catch (error) {
    logger.error('[resolveImagePrompt] Error resolving prompt; using fallback', {
      error: serializeError(error),
    });
    return fallback;
  }
};
