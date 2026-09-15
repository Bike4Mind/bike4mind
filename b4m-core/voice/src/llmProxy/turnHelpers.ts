import { openAiSseChunk, openAiSseDone, type OpenAIChatRequest } from './translator';

/**
 * Speakable text from a reply that may contain a thinking model's reasoning.
 * The pipeline streams reasoning wrapped in `<think>...</think>` before the
 * visible answer. Voice transports must never speak reasoning aloud: strip
 * complete `<think>` blocks, and treat a still-open block (no closing tag) as
 * not-yet-speakable.
 */
export function stripSpokenThinking(text: string): string {
  let visible = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const openIdx = visible.search(/<think>/i);
  if (openIdx !== -1) visible = visible.slice(0, openIdx);
  return visible.replace(/^\s+/, '');
}

/**
 * The user's text for THIS turn - the final message, only if it's a real user
 * utterance. Returns null for non-user / empty turns AND for the silence marker:
 * on no input ElevenLabs sends a user message of "..." (punctuation only).
 * Treating those as "no message" lets the proxy bail without running the pipeline.
 */
export function currentTurnUserMessage(messages: OpenAIChatRequest['messages']): string | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (last.role !== 'user' || typeof last.content !== 'string') return null;
  const text = last.content.trim();
  // No letters/digits: silence marker (".", "?", etc.), not a real turn.
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return null;
  return last.content;
}

/**
 * The voice agent's system prompt as rendered by the transport (already includes
 * any per-user override). The B4M pipeline builds its own prompt, so callers
 * forward this as an extra context message to drive the response persona.
 */
export function extractSystemPrompt(messages: OpenAIChatRequest['messages']): string {
  if (!Array.isArray(messages)) return '';
  return messages
    .filter(m => m.role === 'system' && typeof m.content === 'string')
    .map(m => m.content as string)
    .join('\n\n')
    .trim();
}

/** Minimal SSE sink - the subset of a Node ServerResponse the helpers need. */
export interface SseWriter {
  write: (chunk: string) => void;
  end: () => void;
}

/**
 * Emit a fixed reply as a complete OpenAI SSE response and close the stream.
 * Used for static turns (e.g. silence re-engagement) so the agent speaks without
 * invoking the LLM pipeline. Pass empty `text` to close with no spoken content.
 */
export function writeStaticCompletion(res: SseWriter, model: string, text: string): void {
  const id = `chatcmpl-v2-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);
  if (text) res.write(openAiSseChunk({ id, model, created, contentDelta: text }));
  res.write(openAiSseChunk({ id, model, created, finishReason: 'stop' }));
  res.write(openAiSseDone());
  res.end();
}

// ElevenLabs "buffer words" pattern for slow custom LLMs: a short filler phrase
// emitted as the first SSE chunk so TTS has something to speak while the real
// pipeline runs. Each MUST end with "... " (ellipsis + space) per ElevenLabs
// docs; without it the next reply chunk concatenates and distorts the audio.
// Rotated so the agent doesn't open every turn with the identical line.
// See https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm#buffer-words
export const INITIAL_BUFFER_PHRASES = [
  'Let me think about that... ',
  'One moment... ',
  'Let me look into that... ',
  'Sure, give me a second... ',
  'Okay, let me see... ',
  'Got it, just a moment... ',
  'Alright, let me check... ',
  'Hmm, let me figure that out... ',
];

/** A random initial "buffer words" filler. Always ends with the required "... ". */
export function pickInitialBufferPhrase(): string {
  return INITIAL_BUFFER_PHRASES[Math.floor(Math.random() * INITIAL_BUFFER_PHRASES.length)];
}

/**
 * Emit the ElevenLabs "buffer words" filler as the initial chunk of a turn.
 * Always emits: every turn opens with a brief spoken filler so ElevenLabs has
 * immediate audio while the pipeline runs (cold-start, RAG, tools) before any
 * real reply tokens land, keeping it under the time-to-first-token timeout. The
 * caller's `emit` must NOT advance the streamed-reply baseline (`sent`) - the
 * filler is out-of-band, so the real reply diff stays clean.
 */
export function emitInitialBuffer(emit: (phrase: string) => void, phrase: string = pickInitialBufferPhrase()): void {
  emit(phrase);
}
