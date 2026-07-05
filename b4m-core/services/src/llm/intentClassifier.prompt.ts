/**
 * Prompt + taxonomy for the LLM intent classifier.
 *
 * The classifier decides whether a user message benefits from the ReAct agent
 * loop (multi-step tool use, retrieval, scratchpad reasoning) versus a single
 * chat completion. Optimized for `contextual` queries - the heuristic
 * `classifyQueryComplexity()` already shunts trivial greetings to `simple` and
 * obvious file/agent flows to `complex`.
 *
 * Output ordering is load-bearing: `useAgent` MUST appear first so the
 * streaming early-exit parser in `intentClassifier.ts` can abort as soon as
 * that field resolves. Few-shot examples reinforce that ordering.
 */

export const INTENT_DECISION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    useAgent: {
      type: 'boolean',
      description:
        'true if the query needs the ReAct agent loop (tools, retrieval, multi-step). false for direct chat completion.',
    },
    confidence: {
      type: 'number',
      description: 'Confidence in the routing decision, 0.0 to 1.0.',
      minimum: 0,
      maximum: 1,
    },
    reason: {
      type: 'string',
      description: 'One-sentence justification (max 20 words).',
    },
    signals: {
      type: 'array',
      items: { type: 'string' },
      description: 'Short signal tags from the taxonomy (e.g. "needs_web_search", "personal_opinion").',
    },
  },
  required: ['useAgent', 'confidence', 'reason', 'signals'],
  additionalProperties: false,
} as const;

/**
 * Signal taxonomy - kept short so the model can pattern-match. Positive
 * signals push toward agent routing; negative signals push toward direct chat.
 */
export const POSITIVE_SIGNALS = [
  'needs_web_search',
  'needs_current_data',
  'needs_file_lookup',
  'needs_calculation',
  'multi_step_reasoning',
  'requires_retrieval',
  'compare_sources',
  'verify_facts',
] as const;

export const NEGATIVE_SIGNALS = [
  'personal_opinion',
  'creative_writing',
  'casual_chat',
  'self_contained',
  'definition_only',
  'follow_up_clarification',
  'roleplay',
] as const;

const SYSTEM_PROMPT = `You decide whether a user message should be answered by:
- "agent" — the ReAct agent loop (uses tools: web search, retrieval, file read, code execution, multi-step planning)
- "direct" — a single chat completion (the model answers from training + conversation context)

Choose "agent" when the query needs current data, factual verification, document lookup, calculation, or genuine multi-step reasoning across sources.
Choose "direct" for opinions, creative writing, casual chat, definitions the model knows, role-play, and self-contained follow-ups.

Output a JSON object MATCHING THIS SHAPE EXACTLY, with keys in this order:
{"useAgent": <boolean>, "confidence": <0.0-1.0>, "reason": "<one sentence, max 20 words>", "signals": ["<tag>", ...]}

Positive signals (push toward useAgent=true): ${POSITIVE_SIGNALS.join(', ')}
Negative signals (push toward useAgent=false): ${NEGATIVE_SIGNALS.join(', ')}

Emit "useAgent" FIRST. No prose outside the JSON object. No markdown fences.`;

interface FewShot {
  message: string;
  decision: { useAgent: boolean; confidence: number; reason: string; signals: string[] };
}

const FEW_SHOTS: FewShot[] = [
  {
    message: "What's the current stock price of NVDA?",
    decision: {
      useAgent: true,
      confidence: 0.95,
      reason: 'Requires live market data the model cannot know.',
      signals: ['needs_current_data', 'needs_web_search'],
    },
  },
  {
    message: 'Write a haiku about autumn rain.',
    decision: {
      useAgent: false,
      confidence: 0.98,
      reason: 'Self-contained creative writing task.',
      signals: ['creative_writing', 'self_contained'],
    },
  },
  {
    message: 'Compare the Q3 revenue trends in the two PDFs I uploaded yesterday.',
    decision: {
      useAgent: true,
      confidence: 0.92,
      reason: 'Needs file retrieval and cross-document comparison.',
      signals: ['needs_file_lookup', 'compare_sources', 'multi_step_reasoning'],
    },
  },
  {
    message: 'What do you think about remote work?',
    decision: {
      useAgent: false,
      confidence: 0.9,
      reason: 'Opinion request with no factual dependency.',
      signals: ['personal_opinion', 'casual_chat'],
    },
  },
  {
    message: 'Explain the difference between async and parallel.',
    decision: {
      useAgent: false,
      confidence: 0.88,
      reason: 'Common technical concept the model knows.',
      signals: ['definition_only', 'self_contained'],
    },
  },
];

function renderFewShot(shot: FewShot): string {
  // Mirror the exact JSON key ordering the model is asked to emit.
  const json = JSON.stringify({
    useAgent: shot.decision.useAgent,
    confidence: shot.decision.confidence,
    reason: shot.decision.reason,
    signals: shot.decision.signals,
  });
  return `User: ${shot.message}\nDecision: ${json}`;
}

export interface IntentPromptContext {
  message: string;
  hasFileAttachments?: boolean;
  hasAgentMention?: boolean;
}

export function buildIntentSystemPrompt(): string {
  return [SYSTEM_PROMPT, '', 'Examples:', '', FEW_SHOTS.map(renderFewShot).join('\n\n')].join('\n');
}

export function buildIntentUserPrompt(ctx: IntentPromptContext): string {
  const hints: string[] = [];
  if (ctx.hasFileAttachments) hints.push('User has attached files to this message.');
  if (ctx.hasAgentMention) hints.push('User explicitly @mentioned an agent.');
  const hintLine = hints.length > 0 ? `\nContext: ${hints.join(' ')}\n` : '';
  return `Classify the following user message.${hintLine}\nUser: ${ctx.message}\nDecision:`;
}
